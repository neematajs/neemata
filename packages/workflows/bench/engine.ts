import * as NodeRedis from '@effect/platform-node/NodeRedis'
import { PgClient } from '@effect/sql-pg'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Redis from 'effect/persistence/Redis'
import * as Redacted from 'effect/Redacted'
import * as SqlClient from 'effect/sql/SqlClient'

import type { Store } from '../src/index.ts'
import type { Count, Workload } from './workloads.ts'
import { Client, InMemory, Worker } from '../src/index.ts'
import * as Postgres from '../src/postgres/index.ts'
import * as PostgresPg from '../src/postgres/pg.ts'
import * as RedisStore from '../src/redis/index.ts'
import { served, workloads } from './workloads.ts'

/** Where the engine keeps its runs for a measurement. */
export type Target =
  | { readonly store: 'memory' }
  | {
      readonly store: 'postgres'
      readonly url: string
      /**
       * The port the engine reaches the server through when it is counted.
       * What only watches the engine always goes to the server itself.
       */
      readonly via?: number
    }
  | {
      readonly store: 'redis'
      readonly url: string
      readonly via?: number
    }

export type Concurrency = {
  readonly coordinator: number
  readonly execution: number
}

/** The settings the engine is run with. */
export const SETTINGS = {
  /** Connections of the PostgreSQL pool. */
  poolSize: 16,
  /** The workers' defaults, stated so that a change of them is seen. */
  leaseMs: 30_000,
  pollMs: 250,
  /** Created for a measurement and dropped after it. */
  postgresSchema: 'workflows_bench',
  redisPrefix: 'workflows-bench:',
} as const

/** The engine on one store, driven through its public API alone. */
export type Engine = {
  readonly store: Target['store']
  /** Starts a run and answers with its id. */
  readonly start: (workload: Workload, input: Count) => Promise<string>
  /**
   * Whether any run has not ended: one indexed read however many runs there
   * are, made where it is not counted.
   */
  readonly active: () => Promise<boolean>
  /**
   * Whether a run completed, read where it is not counted. Throws when the
   * run ended any other way: a benchmark of failures measures nothing.
   */
  readonly completed: (runId: string) => Promise<boolean>
  /**
   * Starts a coordinator and an execution worker. The answer stops them and
   * answers with the errors they reported meanwhile: the workers go on after
   * a command fails, so a failure is a cost to see, not the end of a sample.
   */
  readonly serve: (concurrency: Concurrency) => () => Promise<readonly string[]>
  /** Removes every run, so that each sample starts on an empty store. */
  readonly reset: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/** The address of a target, through its counting proxy when it has one. */
export function address(target: { url: string; via?: number }) {
  if (target.via === undefined) return target.url
  const url = new URL(target.url)
  url.hostname = '127.0.0.1'
  url.port = String(target.via)
  return url.toString()
}

/** The statuses of a run that has not ended. */
export const ACTIVE = ['queued', 'running', 'waiting', 'cancelling'] as const

export function unfinished(runId: string, status: string, error: unknown) {
  return new Error(
    `Run [${runId}] ended as ${status}: ${JSON.stringify(error)}`,
  )
}

type Runtime = ManagedRuntime.ManagedRuntime<Store, never>

/**
 * What the workers log as errors, kept for the report in place of the
 * console: a sample is not slowed by printing.
 */
const reported: string[] = []
const errors = Logger.layer([
  Logger.make(({ logLevel, message, cause }) => {
    if (logLevel !== 'Error' && logLevel !== 'Fatal') return
    const text = Array.isArray(message) ? message.join(' ') : String(message)
    const first = Cause.pretty(cause).split('\n')[0]
    reported.push(first ? `${text}: ${first}` : text)
  }),
])

/** A store with what it takes to empty it and to let go of it. */
type Backing = {
  readonly runtime: Runtime
  /** A store of its own on the same data, for reads that are not counted. */
  readonly observer: Runtime
  readonly reset: () => Promise<void>
  readonly dispose: () => Promise<void>
}

async function postgres(
  target: Extract<Target, { store: 'postgres' }>,
): Promise<Backing> {
  const schema = SETTINGS.postgresSchema
  const client = (url: string, maxConnections: number) =>
    Layer.orDie(
      PgClient.layer({
        url: Redacted.make(url),
        maxConnections,
        startupParameters: { search_path: schema },
      }),
    )
  // A channel is the database's: the hints of this schema get their own.
  const store = Postgres.layer({ channel: `hints_${schema}` })

  const direct = ManagedRuntime.make(
    Layer.provideMerge(store, client(target.url, 4)),
  )
  const sql = (statement: string) =>
    direct.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)),
    )
  // The store verifies nothing as it is built, so it may precede its schema.
  await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await sql(`CREATE SCHEMA ${schema}`)
  await direct.runPromise(Postgres.install)

  const runtime = ManagedRuntime.make(
    store.pipe(
      Layer.provide(PostgresPg.notifications),
      Layer.provide(client(address(target), SETTINGS.poolSize)),
      Layer.provideMerge(errors),
    ),
  )
  await runtime.runPromise(Effect.void)

  return {
    runtime,
    observer: direct,
    // Saved definitions stay, as they do between runs in service.
    reset: async () => {
      await sql(
        'TRUNCATE workflow_commands, workflow_keys, workflow_schedules, workflow_runs CASCADE',
      )
    },
    dispose: async () => {
      await runtime.dispose()
      await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      await direct.dispose()
    },
  }
}

async function redis(
  target: Extract<Target, { store: 'redis' }>,
): Promise<Backing> {
  const prefix = SETTINGS.redisPrefix
  const client = (url: string) => Layer.orDie(NodeRedis.layer({ url }))
  const store = RedisStore.layer({ prefix })
  const direct = ManagedRuntime.make(
    Layer.provideMerge(store, client(target.url)),
  )
  const runtime = ManagedRuntime.make(
    store.pipe(
      Layer.provide(client(address(target))),
      Layer.provideMerge(errors),
    ),
  )
  await runtime.runPromise(Effect.void)

  const reset = () =>
    direct.runPromise(
      Effect.gen(function* () {
        const redis = yield* Redis.Redis
        let cursor = '0'
        do {
          const [next, keys] = yield* redis.send<[string, string[]]>(
            'SCAN',
            cursor,
            'MATCH',
            `{${prefix}}*`,
            'COUNT',
            '1000',
          )
          cursor = next
          if (keys.length > 0) yield* redis.send('UNLINK', ...keys)
        } while (cursor !== '0')
      }),
    )
  await reset()

  return {
    runtime,
    observer: direct,
    reset,
    dispose: async () => {
      await runtime.dispose()
      await reset()
      await direct.dispose()
    },
  }
}

function memory(): Backing {
  const made = () =>
    ManagedRuntime.make(Layer.provideMerge(InMemory.layer(), errors))
  let runtime: Runtime = made()
  return {
    get runtime() {
      return runtime
    },
    get observer() {
      return runtime
    },
    reset: async () => {
      await runtime.dispose()
      runtime = made()
      // Built now, so that the first start of a sample does not build it.
      await runtime.runPromise(Effect.void)
    },
    dispose: () => runtime.dispose(),
  }
}

/** The engine: its DSL, `Client` and `Worker`. */
export async function engine(target: Target): Promise<Engine> {
  const backing =
    target.store === 'memory'
      ? memory()
      : target.store === 'postgres'
        ? await postgres(target)
        : await redis(target)

  return {
    store: target.store,
    start: async (workload, input) =>
      (
        await backing.runtime.runPromise(
          Client.start(workloads[workload], input),
        )
      ).id,
    active: async () => {
      const { runs } = await backing.observer.runPromise(
        Client.listSummaries({ status: ACTIVE, limit: 1 }),
      )
      return runs.length > 0
    },
    completed: async (runId) => {
      const records = await backing.observer.runPromise(Client.get(runId))
      const status = records?.run.status
      if (status === 'failed' || status === 'cancelled') {
        throw unfinished(runId, status, records?.run.error)
      }
      return status === 'completed'
    },
    serve(concurrency: Concurrency) {
      const options = { leaseMs: SETTINGS.leaseMs, pollMs: SETTINGS.pollMs }
      reported.length = 0
      const fiber = backing.runtime.runFork(
        Effect.all(
          [
            Worker.coordinator({
              ...options,
              workflows: served.workflows,
              concurrency: concurrency.coordinator,
            }),
            Worker.execution({
              ...options,
              ...served,
              concurrency: concurrency.execution,
            }),
          ],
          { concurrency: 'unbounded', discard: true },
        ),
      )
      return async () => {
        const exit = await backing.runtime.runPromise(
          Effect.andThen(Fiber.interrupt(fiber), Fiber.await(fiber)),
        )
        // Interruption is how workers are stopped; anything else is a failure.
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          throw new Error(`Workers failed: ${Cause.pretty(exit.cause)}`)
        }
        return reported.splice(0)
      }
    },
    reset: backing.reset,
    dispose: backing.dispose,
  }
}
