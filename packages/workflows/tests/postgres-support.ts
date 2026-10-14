import { PgClient } from '@effect/sql-pg'
import { PgliteClient } from '@effect/sql-pglite'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as SqlClient from 'effect/sql/SqlClient'

import type { PostgresOptions } from '../src/postgres/index.ts'
import type { MadeStore, StoreHarness } from './store-contract.ts'
import * as Postgres from '../src/postgres/index.ts'
import * as PostgresPg from '../src/postgres/pg.ts'
import * as PostgresPglite from '../src/postgres/pglite.ts'
import { Store } from '../src/store.ts'

/** Set to run what only a server with several connections can show. */
export const POSTGRES_URL = process.env.POSTGRES_URL

/** A database of its own, in memory, with the schema installed. */
export const pglite = Layer.mergeAll(
  Layer.effectDiscard(Effect.orDie(Postgres.install)),
  PostgresPglite.notifications,
).pipe(Layer.provideMerge(Layer.orDie(PgliteClient.layer())))

/**
 * A schema of its own in the database at `url`, dropped when the layer is
 * released: test files share the database and nothing else.
 */
export function postgres(url: string, options?: { readonly schema?: false }) {
  const schema = `workflows_${crypto.randomUUID().replaceAll('-', '')}`
  const owned = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* Effect.acquireRelease(sql.unsafe(`CREATE SCHEMA ${schema}`), () =>
        Effect.orDie(sql.unsafe(`DROP SCHEMA ${schema} CASCADE`)),
      )
      if (options?.schema !== false) yield* Postgres.install
    }).pipe(Effect.orDie),
  )
  return Layer.mergeAll(owned, PostgresPg.notifications).pipe(
    Layer.provideMerge(
      Layer.orDie(
        PgClient.layer({
          url: Redacted.make(url),
          startupParameters: { search_path: schema },
        }),
      ),
    ),
  )
}

/** Empties every table: one schema serves all the tests of a file in turn. */
export const reset = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.orDie(
    sql.unsafe(
      'TRUNCATE workflow_commands, workflow_keys, workflow_definitions, workflow_schedules, workflow_runs CASCADE',
    ),
  ),
)

/**
 * A store over emptied tables, with whatever listens in the context. Its
 * hints are its schema's: the test files that share a database share its
 * channels too.
 */
export const fresh = Effect.fnUntraced(function* (options?: PostgresOptions) {
  const sql = yield* SqlClient.SqlClient
  yield* reset
  const [{ schema }] = (yield* Effect.orDie(
    sql.unsafe<{ schema: string }>('SELECT current_schema() AS schema'),
  )) as [{ schema: string }]
  return yield* Postgres.make({ channel: `hints_${schema}`, ...options })
})

export const provided = (options?: PostgresOptions) =>
  Layer.effect(Store, fresh(options))

/**
 * A store whose next commit has a writer of its own begin in its gap. The
 * writer runs on another connection, and the commit goes on once the writer
 * has ended or waits for a lock the committing transaction holds.
 */
export const gapped = Effect.fnUntraced(function* (options?: PostgresOptions) {
  const sql = yield* SqlClient.SqlClient
  // The services as they are outside any transaction: a fiber forked in one
  // is part of it, and the writer must not be.
  const outside = yield* Effect.context<never>()
  let pending: Effect.Effect<unknown> | undefined
  let acting: Fiber.Fiber<unknown> | undefined
  let waited = false
  yield* Effect.addFinalizer(() =>
    acting ? Fiber.interrupt(acting) : Effect.void,
  )
  // Asked on the connection of the transaction that commits: `sql` finds it.
  // Of `pg_locks`, which is read as it is: `pg_stat_activity` is read once in
  // a transaction, and would never show a writer that connected later.
  const waitedFor = Effect.map(
    sql.unsafe<{ waited: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_locks
         WHERE NOT granted AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
       ) AS waited`,
    ),
    ([row]) => row!.waited,
  )
  const store = yield* fresh({
    ...options,
    beforeCommit: () =>
      Effect.gen(function* () {
        const act = pending
        pending = undefined
        if (!act) return
        const fiber = Effect.runForkWith(outside)(act)
        acting = fiber
        for (;;) {
          const exit = fiber.pollUnsafe()
          // Died in the gap: so does the commit.
          if (exit) return yield* Exit.asVoid(exit)
          waited = yield* waitedFor
          if (waited) return
          yield* Effect.sleep('5 millis')
        }
      }).pipe(Effect.orDie),
  })
  const made: MadeStore = {
    store,
    inGap: (act) => {
      pending = act
      return Effect.suspend(() =>
        acting ? Effect.as(Fiber.await(acting), waited) : Effect.succeed(false),
      )
    },
  }
  return made
})

/**
 * The database reads its own clock, so its time passes only by waiting.
 * `connections` says whether the client has more than one: a writer in the
 * gap of a commit needs its own, which PGlite does not have.
 */
export const harness = (
  connections: 'many' | 'one',
): StoreHarness<SqlClient.SqlClient> => ({
  make: (options) =>
    connections === 'many'
      ? gapped(options)
      : Effect.map(fresh(options), (store) => ({ store })),
  // A timer may fire a moment early by the clock the database reads.
  elapse: (ms) => Effect.sleep(ms + 10),
  hints: true,
  gap: connections === 'many',
})
