import type * as Duration from 'effect/Duration'
import type { WorkflowEngine } from 'effect/workflow'
import {
  ClusterWorkflowEngine,
  RunnerAddress,
  RunnerHealth,
  Runners,
  Sharding,
  ShardingConfig,
  SqlMessageStorage,
  SqlRunnerStorage,
} from 'effect/cluster'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import { SqlClient } from 'effect/sql'

/** Keeps native tables apart from Neemata's own and from other Effect clusters. */
export const defaultPrefix = 'nmtjs_native'

export type Runner = {
  /**
   * Stable name of the machine or process group. Together with `slot` it
   * identifies this runner to the others, so two live runners must never
   * share both. A restarted runner should come back under the same identity:
   * it then reclaims its own shards without waiting for them to expire.
   */
  readonly host: string
  /** Distinguishes runners that share a host, such as worker threads. */
  readonly slot: number
  /** Pools whose workflows and tasks this runner executes. */
  readonly pools: readonly string[]
  /** Share of each pool's shards relative to other runners; 1 by default. */
  readonly weight?: number
}

export type SqlEngineOptions = {
  /** Every pool any runner in the deployment serves. */
  readonly pools: readonly string[]
  /** Omit for a client that starts and inspects executions but runs none. */
  readonly runner?: Runner
  readonly prefix?: string
  /**
   * How often a runner looks in storage for work addressed to it. Runners do
   * not talk to each other, so this bounds the delay before a task placed on
   * another runner starts and before a timer fires.
   */
  readonly pollInterval?: Duration.Input
  /**
   * How long a stopping runner lets executions reach a checkpoint before it
   * abandons them to the next owner. Keep it below the host's stop budget.
   */
  readonly terminationTimeout?: Duration.Input
  /** Any other sharding setting; these win over the options above. */
  readonly sharding?: Partial<ShardingConfig.ShardingConfig['Service']>
}

/**
 * A definition, as far as announcing it to the engine is concerned. `R` is
 * what its result schemas need in order to decode.
 */
export type Known<R = never> = {
  readonly poll: (
    executionId: string,
  ) => Effect.Effect<unknown, never, WorkflowEngine.WorkflowEngine | R>
}

export function shardingConfig(options: SqlEngineOptions) {
  const { runner, pools } = options
  const address = runner
    ? Option.some(RunnerAddress.make(runner.host, runner.slot))
    : Option.none()

  return ShardingConfig.layer({
    runnerAddress: address,
    runnerShardWeight: runner?.weight ?? 1,
    availableShardGroups: pools,
    assignedShardGroups: runner?.pools ?? [],
    entityMessagePollInterval: options.pollInterval ?? '500 millis',
    entityTerminationTimeout: options.terminationTimeout ?? '5 seconds',
    // Effect's defaults assume a 35 second lease. These keep a crashed
    // runner's shards unowned for about 15 seconds instead, and let a stopping
    // runner hand over inside a 15 second host stop budget.
    shardLockRefreshInterval: '2 seconds',
    shardLockExpiration: '15 seconds',
    refreshAssignmentsInterval: '1 second',
    ...options.sharding,
  })
}

/**
 * Makes definitions known to a runner that does not execute them.
 *
 * The engine routes by definition: when a task finishes it wakes its parent,
 * and it needs the parent's definition to find the parent's pool. A runner
 * that serves only the task's pool has never seen it otherwise, and the wake
 * fails. List every definition of the deployment on every runner.
 *
 * A lookup is typed to decode a result, so the layer requires the services
 * that the listed definitions' success and error schemas decode with.
 */
export function layerCatalog<R = never>(definitions: Iterable<Known<R>>) {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      for (const definition of definitions) {
        // The engine has no call that only records a definition; looking up
        // an execution that cannot exist does, and costs one read.
        yield* definition.poll('')
      }
    }),
  )
}

/**
 * The persistent engine: Effect's cluster workflow engine with SQL message
 * and runner storage and no runner-to-runner transport.
 *
 * Every message is persisted, and its owner finds it by polling storage, so
 * runners need a shared database and nothing else. Membership is a heartbeat
 * row per runner; shard ownership is a lock per shard.
 *
 * Acquiring this layer creates the `<prefix>_*` tables when they are missing,
 * which needs DDL permission. To migrate with another role, build the storage
 * layers yourself and compose them as this function does.
 */
export function layerSql(options: SqlEngineOptions) {
  const prefix = options.prefix ?? defaultPrefix
  const storage = Layer.mergeAll(
    SqlMessageStorage.layerWith({ prefix }),
    Layer.orDie(SqlRunnerStorage.layerWith({ prefix })),
  )

  return ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(Sharding.layer),
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(serialized(prefix, storage)),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(shardingConfig(options)),
  )
}

/**
 * Builds `layer` while holding a database lock named after the prefix.
 *
 * Both storage layers create their tables when they are acquired. Runners
 * that boot together, such as the threads of one Neem process, would
 * otherwise race to create the same tables and fail to start. Only
 * PostgreSQL is locked; other dialects are built as they are.
 */
function serialized<A, E, R>(prefix: string, layer: Layer.Layer<A, E, R>) {
  const key = `nmtjs-native-effect:${prefix}`

  return Layer.effectContext(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const scope = yield* Effect.scope
      const build = Layer.buildWithScope(layer, scope)

      return yield* sql.onDialectOrElse({
        orElse: () => build,
        pg: () =>
          Effect.scoped(
            Effect.gen(function* () {
              // A session lock lives on one connection, so the unlock has to
              // go through the connection that took it.
              const connection = yield* sql.reserve
              // Registered first: an interruption can land after the server
              // granted the lock but before this fiber learns of it. Unlocking
              // a lock that was never taken only draws a warning.
              yield* Effect.addFinalizer(() =>
                connection
                  .executeRaw(
                    'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
                    [key],
                  )
                  .pipe(Effect.ignore),
              )
              // Polled instead of blocking in the database, so a runner that
              // is told to stop while it waits can still be interrupted.
              yield* connection
                .executeValues(
                  'SELECT pg_try_advisory_lock(hashtextextended($1, 0))',
                  [key],
                )
                .pipe(
                  Effect.map((rows) => rows[0]?.[0] === true),
                  Effect.repeat({
                    until: (held) => held,
                    schedule: Schedule.spaced('100 millis'),
                  }),
                )
              return yield* build
            }),
          ),
      })
    }),
  )
}
