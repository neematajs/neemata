import type { Vitest } from '@effect/vitest'
import type * as Scope from 'effect/Scope'
import { PgliteClient } from '@effect/sql-pglite'
import { describe, expect, it, layer } from '@effect/vitest'
import { getTableConfig } from 'drizzle-orm/pg-core'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Latch from 'effect/Latch'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlError from 'effect/sql/SqlError'

import type { Registry, WorkflowProgram } from '../src/index.ts'
import type { StoredRun } from '../src/model.ts'
import type { Claim, Mutation, Planned } from '../src/store.ts'
import { begin, coordinate, fire, settle, start } from '../src/engine.ts'
import { RunBusy, StaleClaim, StorageError } from '../src/errors.ts'
import { Client, registry, unitKey, Worker } from '../src/index.ts'
import { continueRun, isTerminal } from '../src/model.ts'
import { idempotencyKey, uniqueKey } from '../src/plan/keys.ts'
import { createSchema } from '../src/postgres/drizzle.ts'
import * as Postgres from '../src/postgres/index.ts'
import { CLAIM } from '../src/postgres/store.ts'
import { Store } from '../src/store.ts'
import {
  Billing,
  CreateInvoice,
  ManualBilling,
  RecordPayment,
  RequestApproval,
} from './fixtures/billing.ts'
import { GENERATION_4 } from './postgres-generation-4.ts'
import {
  fresh,
  gapped,
  pglite,
  postgres,
  POSTGRES_URL,
  provided,
} from './postgres-support.ts'

const database = Layer.orDie(PgliteClient.layer())
/** For suites whose tests each start a database: seconds on a slow runner. */
const slow = { timeout: 30_000 }
const options = { excludeTestServices: true, timeout: '60 seconds' } as const

const commit = <A>(mutation: Mutation, result: A): Planned<A> => ({
  _tag: 'Commit',
  mutation,
  result,
})

const stored = (id: string, now: number, patch?: Partial<StoredRun>) =>
  ({
    id,
    kind: 'workflow',
    name: 'flow',
    status: 'running',
    input: 1,
    rootRunId: id,
    tags: {},
    version: 1,
    activeSince: now,
    createdAt: now,
    updatedAt: now,
    ...patch,
  }) satisfies StoredRun

const create = Effect.flatMap(Store, (store) =>
  store.transact({}, (snapshot) => {
    const run = stored(snapshot.id('run'), snapshot.now)
    return commit(
      {
        runs: [run],
        enqueue: [{ command: continueRun(run), dedupe: `continue:${run.id}` }],
      },
      run,
    )
  }),
)

const bump = (runId: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ runs: [runId] }, (snapshot) => {
      const { run } = snapshot.runs.get(runId)!
      return commit({ runs: [{ ...run, version: run.version + 1 }] }, undefined)
    }),
  )

const claim = (limit = 10) =>
  Effect.flatMap(Store, (store) =>
    store.claim({
      lanes: [{ kind: 'continueRun', routes: [{ name: 'flow' }] }],
      limit,
      leaseMs: 60_000,
    }),
  )

const query = <Row extends object = Record<string, unknown>>(text: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<Row>(text))

const apply = (statements: readonly string[]) =>
  Effect.forEach(statements, query, { discard: true })

/** What the database said, when an operation failed as the contract says. */
const storageFailure = (exit: Exit.Exit<unknown, unknown>) => {
  const error = Exit.isFailure(exit)
    ? Cause.findErrorOption(exit.cause)
    : Option.none()
  expect(Option.getOrUndefined(error)).toBeInstanceOf(StorageError)
  const { cause } = Option.getOrThrow(error) as StorageError
  expect(SqlError.isSqlError(cause)).toBe(true)
  return cause as SqlError.SqlError
}

/**
 * A time with microseconds, as `now()` writes one, and the whole milliseconds
 * the store reads it as: rounded down, which `.678999` tells from rounding.
 */
const MICROS = '2026-01-02T03:04:05.678999Z'
const MILLIS = Date.parse('2026-01-02T03:04:05.678Z')

/** What the column of the table's one row holds, rounded down to ms, exactly. */
const floored = (table: string, column: string) =>
  Effect.map(
    query<{ micros: string }>(
      `SELECT (extract(epoch FROM ${column}) * 1000000)::bigint::text AS micros
       FROM ${table}`,
    ),
    ([row]) => Number(BigInt(row!.micros) / 1000n),
  )

// Each test starts a database of its own and installs or migrates a whole
// schema in it: seconds on a slow runner, past the default timeout.
describe('the schema', slow, () => {
  const tables = [...Object.keys(Postgres.COLUMNS), 'workflow_schema_version']
  const listed = tables.map((table) => `'${table}'`).join(', ')

  /** Everything the catalog says of the engine's tables, in one order. */
  const catalog = Effect.gen(function* () {
    const columns = yield* query(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default,
              is_identity, identity_generation
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name IN (${listed})
       ORDER BY table_name, column_name`,
    )
    const indexes = yield* query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename IN (${listed})
       ORDER BY indexname`,
    )
    const constraints = yield* query(
      `SELECT rel.relname AS table_name, con.conname,
              pg_get_constraintdef(con.oid) AS definition
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relnamespace = current_schema()::regnamespace
         AND rel.relname IN (${listed})
       ORDER BY rel.relname, con.conname`,
    )
    const enums = yield* query(
      `SELECT t.typname, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       WHERE t.typnamespace = current_schema()::regnamespace
       GROUP BY t.typname ORDER BY t.typname`,
    )
    const others = yield* query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = current_schema() AND tablename NOT IN (${listed})
       ORDER BY tablename`,
    )
    return { columns, indexes, constraints, enums, others }
  })

  // In a database of its own, whatever the test's is.
  const installed = Effect.provide(
    Effect.andThen(Postgres.install, catalog),
    Layer.fresh(database),
  )

  const RUN = '00000000-0000-4000-8000-000000000001'
  const ATTEMPT = '00000000-0000-4000-8000-000000000002'
  const IDEMPOTENCY = ['order', 42, { b: [true, null], a: 'é"', 10: 1, 9: 2 }]
  const UNIQUE = ['customer', 'c-1']
  /** A finished run of the old engine, with all it left behind. */
  const history = [
    `INSERT INTO workflow_runs (
       id, kind, name, workflow_name, status, input, output, root_run_id, tags,
       idempotency_key, unique_key, unique_scope, unique_behavior, version,
       created_at, updated_at
     ) VALUES (
       '${RUN}', 'workflow', 'billing', 'billing', 'completed', '{"id": "o-1"}',
       '{"paid": true}', '${RUN}', '{"tenant": "a"}',
       '${JSON.stringify(IDEMPOTENCY)}', '${JSON.stringify(UNIQUE)}', 'all',
       'reject', 4, '2026-01-02T03:04:05.678Z', '2026-01-02T03:04:06.789Z'
     )`,
    `INSERT INTO workflow_nodes (
       run_id, name, kind, status, output, version, created_at, updated_at
     ) VALUES (
       '${RUN}', 'step', 'task', 'completed', '1', 2,
       '2026-01-02T03:04:05.678Z', '2026-01-02T03:04:06Z'
     )`,
    `INSERT INTO workflow_attempts (
       id, run_id, node_name, child_key, status, worker_id, lease_token,
       attempt_number, retry_attempt_number, input, dispatched_at
     ) VALUES (
       '${ATTEMPT}', '${RUN}', 'step', '$self', 'completed', 'worker', 'token',
       1, 1, '{}', '2026-01-02T03:04:05.678Z'
     )`,
    `INSERT INTO workflow_node_children (
       run_id, node_name, child_key, kind, status, item_key, current_attempt_id,
       attempt_count, version, created_at, updated_at
     ) VALUES (
       '${RUN}', 'step', '$self', 'task', 'completed', 'k', '${ATTEMPT}', 1, 2,
       '2026-01-02T03:04:05.678Z', '2026-01-02T03:04:06Z'
     )`,
    `INSERT INTO workflow_commands (
       id, kind, run_id, workflow_name, payload, lease_token, delivery_count,
       dead_at
     ) VALUES (
       gen_random_uuid(), 'continue', '${RUN}', 'billing', '{"old": true}',
       'dead', 20, now()
     )`,
  ]
  const SLOT = '2026-01-02T04:00:00.000Z'
  /** A schedule the old engine was firing, and the run of its last slot. */
  const scheduled = [
    `INSERT INTO workflow_schedules (
       id, name, runnable_kind, runnable_name, input, tags, cron, enabled,
       next_run_at, last_slot_at, created_at, updated_at
     ) VALUES (
       gen_random_uuid(), 'nightly', 'workflow', 'billing', '{"id": "o-2"}',
       '{"tenant": "a"}', '0 4 * * *', true, '${SLOT}',
       '2026-01-01T04:00:00Z', '2025-12-01T00:00:00Z', '2026-01-01T04:00:00Z'
     )`,
    `UPDATE workflow_runs
     SET idempotency_key = '["$schedule", "nightly", ${Date.parse(SLOT)}]'`,
  ]
  const generation4 = apply([...GENERATION_4, ...history])
  /** A column the migration drops, still there. */
  const untouched = query('SELECT workflow_name FROM workflow_runs')

  it.live('installs what verification asks for', () =>
    Effect.gen(function* () {
      yield* Postgres.install
      yield* Postgres.verify

      // The listing is the whole of each table: a column that is added
      // without being listed would go unverified.
      const { columns } = yield* catalog
      for (const [table, listed] of Object.entries(Postgres.COLUMNS)) {
        const names = listed.split(', ').map((column) => column.split(' ')[0])
        expect(new Set(names)).toEqual(
          new Set(
            columns
              .filter((column) => column.table_name === table)
              .map((column) => column.column_name),
          ),
        )
      }
    }).pipe(Effect.provide(database)),
  )

  it.live('verification names what is wrong', () =>
    Effect.gen(function* () {
      const failure = Effect.fnUntraced(function* (change: string) {
        yield* query(change)
        const exit = yield* Effect.exit(Postgres.verify)
        return String(Exit.isFailure(exit) && Cause.squash(exit.cause))
      })
      yield* Postgres.install

      expect(
        yield* failure('DROP INDEX workflow_commands_fresh_idx'),
      ).toContain(
        'Missing workflow schema indexes: workflow_commands_fresh_idx',
      )
      expect(
        yield* failure(
          'ALTER TABLE workflow_runs ALTER COLUMN name DROP NOT NULL',
        ),
      ).toContain('workflow_runs.name (text?, expected text)')
      expect(
        yield* failure('ALTER TABLE workflow_keys DROP COLUMN run_id'),
      ).toContain('workflow_keys.run_id (missing, expected uuid)')
      // The generation is told first, whatever else is wrong.
      expect(
        yield* failure('UPDATE workflow_schema_version SET version = 5'),
      ).toContain(
        'Unsupported workflow schema generation [5], expected [7]: apply the schema upgrades',
      )
      expect(yield* failure('DELETE FROM workflow_schema_version')).toContain(
        'Missing workflow schema version',
      )
    }).pipe(Effect.provide(database)),
  )

  it.live('migrating generation 4 gives the schema an install gives', () =>
    Effect.gen(function* () {
      const expected = yield* installed
      yield* generation4
      yield* Postgres.migrateFrom4
      yield* Postgres.verify

      const migrated = yield* catalog
      expect(migrated).toEqual(expected)
    }).pipe(Effect.provide(database)),
  )

  it.live('migrating generation 6 gives the schema an install gives', () =>
    Effect.gen(function* () {
      const expected = yield* installed
      yield* generation4
      // Generation 6 as the release before this one installed it: the
      // migration from 4 without the steps from 6 that end it.
      const to6 = Postgres.MIGRATION_FROM_4.slice(
        0,
        -Postgres.MIGRATION_FROM_6.length,
      )
      const { pglite } = yield* PgliteClient.PgliteClient
      yield* Effect.promise(() =>
        pglite.exec(
          `BEGIN; ${to6.join(';\n')}; UPDATE workflow_schema_version SET version = 6; COMMIT;`,
        ),
      )
      yield* Postgres.migrateFrom6
      yield* Postgres.verify
      expect(yield* catalog).toEqual(expected)

      // What generation 6 stored reads as it did.
      const store = yield* Postgres.make()
      const loaded = yield* store.load(RUN)
      expect(loaded?.nodes.every((node) => node.operation === undefined)).toBe(
        true,
      )
    }).pipe(Effect.provide(database)),
  )

  it.live('the migration as one script does the same', () =>
    Effect.gen(function* () {
      const expected = yield* installed
      yield* generation4
      const { pglite } = yield* PgliteClient.PgliteClient
      yield* Effect.promise(() => pglite.exec(Postgres.MIGRATION_FROM_4_SQL))
      yield* Postgres.verify
      expect(yield* catalog).toEqual(expected)
    }).pipe(Effect.provide(database)),
  )

  it.live('the migration keeps history and identity keys', () =>
    Effect.gen(function* () {
      yield* generation4
      yield* Postgres.migrateFrom4
      const store = yield* Postgres.make()

      // What the old engine stored reads as records of the new one.
      const created = Date.parse('2026-01-02T03:04:05.678Z')
      expect(yield* store.load(RUN)).toEqual({
        run: {
          id: RUN,
          kind: 'workflow',
          name: 'billing',
          status: 'completed',
          input: { id: 'o-1' },
          output: { paid: true },
          rootRunId: RUN,
          tags: { tenant: 'a' },
          idempotencyKey: IDEMPOTENCY,
          unique: { key: UNIQUE, scope: 'all', behavior: 'reject' },
          version: 4,
          activeSince: expect.any(Number),
          createdAt: created,
          updatedAt: Date.parse('2026-01-02T03:04:06.789Z'),
        },
        nodes: [
          {
            runId: RUN,
            name: 'step',
            kind: 'task',
            status: 'completed',
            output: 1,
            version: 2,
            createdAt: created,
            updatedAt: Date.parse('2026-01-02T03:04:06Z'),
          },
        ],
        children: [
          {
            runId: RUN,
            nodeName: 'step',
            childKey: '$self',
            kind: 'task',
            status: 'completed',
            ordinal: 0,
            currentAttemptId: ATTEMPT,
            attemptCount: 1,
            version: 2,
            createdAt: created,
            updatedAt: Date.parse('2026-01-02T03:04:06Z'),
          },
        ],
        attempts: [
          {
            id: ATTEMPT,
            runId: RUN,
            nodeName: 'step',
            childKey: '$self',
            status: 'completed',
            attemptNumber: 1,
            retryAttemptNumber: 1,
            input: {},
            dispatchedAt: created,
          },
        ],
      })

      // Keys are found under the names the plans give them.
      const keys = [
        idempotencyKey(IDEMPOTENCY),
        uniqueKey({ key: UNIQUE, scope: 'all' }),
      ]
      const seen = yield* store.transact({ keys }, (snapshot) =>
        commit({}, Array.from(snapshot.keys.values())),
      )
      expect(seen).toEqual([RUN, RUN])

      // So a start that repeats an old idempotency key is answered with the
      // run the old engine created for it.
      const again = yield* Effect.provideService(
        start({
          name: 'billing',
          input: { id: 'o-1' },
          idempotencyKey: IDEMPOTENCY,
        }),
        Store,
        store,
      )
      expect(again).toMatchObject({ created: false, run: { id: RUN } })

      // The old engine's dead commands are no commands of this one: gone.
      expect(yield* store.dead({ limit: 10 })).toEqual({ items: [] })
      expect(yield* query('SELECT id FROM workflow_commands')).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(database)),
  )

  it.live(
    'times the old engine wrote with microseconds read as whole milliseconds',
    () =>
      Effect.gen(function* () {
        yield* generation4
        // As the old engine stamped them, by `now()`: `active_since` already is.
        yield* apply([
          `UPDATE workflow_runs SET updated_at = '${MICROS}'`,
          `UPDATE workflow_nodes SET updated_at = '${MICROS}'`,
          `UPDATE workflow_node_children
           SET created_at = '${MICROS}', updated_at = '${MICROS}'`,
          `UPDATE workflow_attempts
           SET dispatched_at = '${MICROS}', completed_at = '${MICROS}'`,
        ])
        yield* Postgres.migrateFrom4
        const activeSince = yield* floored('workflow_runs', 'active_since')
        const store = yield* Postgres.make()

        expect(yield* store.load(RUN)).toMatchObject({
          run: { activeSince, updatedAt: MILLIS },
          nodes: [{ updatedAt: MILLIS }],
          children: [{ createdAt: MILLIS, updatedAt: MILLIS }],
          attempts: [{ dispatchedAt: MILLIS, completedAt: MILLIS }],
        })
      }).pipe(Effect.scoped, Effect.provide(database)),
  )

  const ROOT = '00000000-0000-4000-8000-000000000011'
  const CHILD = '00000000-0000-4000-8000-000000000012'
  const FAILED = '00000000-0000-4000-8000-000000000013'
  const failure = `'{"message": "declined"}'`
  /** A family the old engine left failed: a root, a run under it. */
  const failedFamily = [
    `INSERT INTO workflow_runs (
       id, kind, name, workflow_name, status, input, error, root_run_id,
       version, created_at, updated_at
     ) VALUES (
       '${ROOT}', 'workflow', 'billing', 'billing', 'failed', '"o-3"',
       ${failure}, '${ROOT}', 3, now(), now()
     )`,
    `INSERT INTO workflow_nodes (
       run_id, name, kind, status, input, error, version, created_at, updated_at
     ) VALUES (
       '${ROOT}', 'step', 'workflow', 'failed', '"o-3"', ${failure}, 2, now(),
       now()
     )`,
    `INSERT INTO workflow_runs (
       id, kind, name, workflow_name, status, input, error, parent_run_id,
       parent_node_name, root_run_id, version, created_at, updated_at
     ) VALUES (
       '${CHILD}', 'workflow', 'billing.child', 'billing.child', 'failed',
       '"o-3"', ${failure}, '${ROOT}', 'step', '${ROOT}', 3, now(), now()
     )`,
    `INSERT INTO workflow_nodes (
       run_id, name, kind, status, input, error, version, created_at, updated_at
     ) VALUES (
       '${CHILD}', 'work', 'activity', 'failed', '"o-3"', ${failure}, 2, now(),
       now()
     )`,
    `INSERT INTO workflow_attempts (
       id, run_id, node_name, child_key, status, attempt_number,
       retry_attempt_number, input, error, dispatched_at, completed_at
     ) VALUES (
       '${FAILED}', '${CHILD}', 'work', '$self', 'failed', 1, 1, '"o-3"',
       ${failure}, now(), now()
     )`,
    `INSERT INTO workflow_node_children (
       run_id, node_name, child_key, kind, status, input, error, child_run_id,
       current_attempt_id, attempt_count, version, created_at, updated_at
     ) VALUES (
       '${ROOT}', 'step', '$self', 'workflow', 'failed', '"o-3"', ${failure},
       '${CHILD}', NULL, 0, 2, now(), now()
     ), (
       '${CHILD}', 'work', '$self', 'activity', 'failed', '"o-3"', ${failure},
       NULL, '${FAILED}', 1, 2, now(), now()
     )`,
  ]
  /**
   * The code of that family, as a new engine's worker has it: unversioned,
   * as the runs of generation 4 are.
   */
  const served = registry([
    {
      kind: 'workflow',
      name: 'billing',
      steps: [
        {
          kind: 'workflow',
          name: 'step',
          workflow: { name: 'billing.child' },
          input: (_outputs, input) => input,
        },
      ],
      result: ({ step }) => step,
    } satisfies WorkflowProgram,
    {
      kind: 'workflow',
      name: 'billing.child',
      steps: [
        {
          kind: 'activity',
          name: 'work',
          execute: (input) => Effect.succeed(`${String(input)} paid`),
          input: (_outputs, input) => input,
        },
      ],
      result: ({ work }) => work,
    },
  ])
  /** Passes and attempts, until nothing is due. */
  const drain = Effect.fnUntraced(function* (served: Registry) {
    const store = yield* Store
    const claimed = <K extends 'continueRun' | 'runAttempt'>(kind: K) =>
      store.claim({
        lanes: [{ kind, routes: served.workflows }],
        limit: 10,
        leaseMs: 60_000,
      })
    for (let round = 0; round < 20; round++) {
      const passes = yield* claimed('continueRun')
      for (const claim of passes) yield* coordinate(served, claim)
      const attempts = yield* claimed('runAttempt')
      for (const claim of attempts) {
        const begun = yield* begin(served, claim)
        if (begun._tag !== 'Begun') continue
        const { execute } = begun.executable
        const output = yield* execute(claim.command.input, begun.attempt)
        yield* settle(served, claim, { _tag: 'Completed', output })
      }
      if (passes.length === 0 && attempts.length === 0) return
    }
    return yield* Effect.die('Did not settle')
  })

  for (const [entry, migrate] of [
    ['migrateFrom4', Postgres.migrateFrom4],
    [
      'the script',
      Effect.flatMap(PgliteClient.PgliteClient, ({ pglite }) =>
        Effect.promise(() => pglite.exec(Postgres.MIGRATION_FROM_4_SQL)),
      ),
    ],
  ] as const) {
    it.live(
      `a failed family migrated by ${entry} is retried, its runs waking their parents`,
      () =>
        Effect.gen(function* () {
          yield* apply([...GENERATION_4, ...history, ...failedFamily])
          yield* migrate
          // A run under a parent is given the parent's route, as a new one
          // is created with: the unversioned lane of the parent's name.
          expect(
            yield* query(
              `SELECT id, parent_route_name AS name,
                      parent_route_revision AS revision
               FROM workflow_runs ORDER BY id`,
            ),
          ).toEqual([
            { id: RUN, name: null, revision: null },
            { id: ROOT, name: null, revision: null },
            { id: CHILD, name: 'billing', revision: null },
          ])

          const store = yield* Postgres.make()
          yield* Effect.provideService(
            Effect.andThen(Client.retry(ROOT), drain(served)),
            Store,
            store,
          )
          // The child is reopened and completes, and its wake, on the root's
          // unversioned lane, is what brings the root to its end.
          const child = (yield* store.load(CHILD))?.run
          expect(child).toMatchObject({
            status: 'completed',
            parentRoute: { name: 'billing' },
          })
          expect(child?.parentRoute).not.toHaveProperty('revision')
          expect((yield* store.load(ROOT))?.run).toMatchObject({
            status: 'completed',
            output: 'o-3 paid',
          })
        }).pipe(Effect.scoped, Effect.provide(database)),
    )
  }

  // What SQL writes otherwise than JavaScript: the order of object keys once
  // one is beyond the BMP, and the numbers JavaScript prints with an exponent.
  const AWKWARD = {
    'keys beyond the BMP': ['k', { '\u{1f600}': 1, '\uff5e': 2 }],
    'a large number': ['k', 1e21],
    'a small number': ['k', { n: [1e-7] }],
  }
  const rekeyed = (key: unknown) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.unsafe(
        `UPDATE workflow_runs
         SET idempotency_key = $1::jsonb, unique_key = $1::jsonb`,
        [JSON.stringify(key)],
      ),
    )

  it.live('the migration carries over keys SQL cannot write', () =>
    Effect.gen(function* () {
      const key = Object.values(AWKWARD)
      yield* generation4
      yield* rekeyed(key)
      yield* Postgres.migrateFrom4
      const store = yield* Postgres.make()

      const keys = [idempotencyKey(key), uniqueKey({ key, scope: 'all' })]
      expect(
        yield* store.transact({ keys }, (snapshot) =>
          commit({}, Array.from(snapshot.keys.values())),
        ),
      ).toEqual([RUN, RUN])
    }).pipe(Effect.scoped, Effect.provide(database)),
  )

  for (const [what, key] of Object.entries(AWKWARD)) {
    it.live(`the migration as one script refuses a key with ${what}`, () =>
      Effect.gen(function* () {
        yield* generation4
        yield* rekeyed(key)
        const { pglite } = yield* PgliteClient.PgliteClient
        const error = yield* Effect.flip(
          Effect.tryPromise(() => pglite.exec(Postgres.MIGRATION_FROM_4_SQL)),
        )
        expect(String(error.cause)).toContain(
          `cannot write the identity keys of workflow runs ${RUN} as the engine does`,
        )

        // Refused whole: nothing of the old schema was touched.
        yield* Effect.promise(() => pglite.exec('ROLLBACK'))
        expect(yield* untouched).toEqual([{ workflow_name: 'billing' }])
      }).pipe(Effect.provide(database)),
    )
  }

  it.live('the migration keeps schedules at the slots they were at', () =>
    Effect.gen(function* () {
      yield* generation4
      yield* apply(scheduled)
      yield* Postgres.migrateFrom4
      const store = yield* Postgres.make()

      const nightly = {
        name: 'nightly',
        runnable: { kind: 'workflow', name: 'billing' },
        input: { id: 'o-2' },
        tags: { tenant: 'a' },
        cron: '0 4 * * *',
        enabled: true,
        nextRunAt: Date.parse(SLOT),
        lastSlotAt: Date.parse('2026-01-01T04:00:00Z'),
        version: 1,
        createdAt: Date.parse('2025-12-01T00:00:00Z'),
        updatedAt: Date.parse('2026-01-01T04:00:00Z'),
      }
      expect(yield* store.schedules({ limit: 10 })).toEqual({
        items: [nightly],
      })

      // The old engine had started the run of that slot and not recorded
      // it: the slot is not fired again, and the schedule moves on.
      const fired = yield* Effect.provideService(fire('nightly'), Store, store)
      expect(fired).toMatchObject({ created: false, run: { id: RUN } })
      expect(
        yield* query('SELECT count(*)::int AS runs FROM workflow_runs'),
      ).toEqual([{ runs: 1 }])
      const [moved] = (yield* store.schedules({ limit: 10 })).items
      expect(moved).toMatchObject({ lastSlotAt: Date.parse(SLOT), version: 2 })
      expect(moved!.nextRunAt).toBeGreaterThan(Date.now())
    }).pipe(Effect.scoped, Effect.provide(database)),
  )

  it.live('the migration refuses work the old engine has in flight', () =>
    Effect.gen(function* () {
      const refused = Effect.fnUntraced(function* (change: string) {
        yield* query(change)
        const error = yield* Effect.flip(Postgres.migrateFrom4)
        return String((error.reason.cause as Error).message)
      })
      yield* generation4

      expect(
        yield* refused(
          `UPDATE workflow_commands SET dead_at = NULL, lease_token = 'held'`,
        ),
      ).toContain('workflow commands are still queued')
      yield* query('DELETE FROM workflow_commands')
      expect(
        yield* refused(`UPDATE workflow_runs SET status = 'waiting'`),
      ).toContain('workflow runs are still in flight')
      // A generation this branch once had, which no release installed.
      expect(
        yield* refused('UPDATE workflow_schema_version SET version = 5'),
      ).toContain('this upgrade applies to generation 4 only')
      expect(
        yield* refused('UPDATE workflow_schema_version SET version = 3'),
      ).toContain('this upgrade applies to generation 4 only')

      // Refused whole: nothing of the old schema was touched.
      expect(yield* untouched).toEqual([{ workflow_name: 'billing' }])
    }).pipe(Effect.provide(database)),
  )

  it.live('the Drizzle schema is the installed one', () =>
    Effect.gen(function* () {
      yield* Postgres.install
      const { columns, indexes, constraints } = yield* catalog
      const types: Record<string, string> = {
        integer: 'int4',
        bigint: 'int8',
        boolean: 'bool',
        'timestamp with time zone': 'timestamptz',
      }

      for (const table of Object.values(createSchema().tables)) {
        const config = getTableConfig(table)
        const of = <Row extends Record<string, unknown>>(
          rows: readonly Row[],
          column: keyof Row = 'table_name',
        ) => rows.filter((row) => row[column] === config.name)

        // Sets and maps: the catalog's order is its collation's, not ours.
        expect(
          Object.fromEntries(
            config.columns.map((column) => [
              column.name,
              {
                udt_name: types[column.getSQLType()] ?? column.getSQLType(),
                is_nullable: column.notNull ? 'NO' : 'YES',
                defaulted:
                  column.hasDefault || column.generatedIdentity !== undefined,
              },
            ]),
          ),
        ).toEqual(
          Object.fromEntries(
            of(columns).map((column) => [
              column.column_name,
              {
                udt_name: column.udt_name,
                is_nullable: column.is_nullable,
                defaulted:
                  column.column_default !== null ||
                  column.is_identity === 'YES',
              },
            ]),
          ),
        )

        // Primary keys and unique constraints are indexes Drizzle names
        // elsewhere: the rest are declared one by one.
        const backing = of(constraints).map(({ conname }) => conname)
        expect(
          new Set(config.indexes.map(({ config }) => config.name)),
        ).toEqual(
          new Set(
            of(indexes, 'tablename')
              .map(({ indexname }) => indexname)
              .filter((name) => !backing.includes(name)),
          ),
        )
        // An index is what it is over: the columns of each, in their order.
        for (const { config: declared } of config.indexes) {
          const installed = of(indexes, 'tablename').find(
            ({ indexname }) => indexname === declared.name,
          )
          expect(/\(([^)]*)\)/.exec(String(installed?.indexdef))?.[1]).toBe(
            declared.columns
              .map((column) => (column as { name: string }).name)
              .join(', '),
          )
        }
        const named = (type: string) =>
          new Set(
            of(constraints)
              .filter(({ definition }) => String(definition).startsWith(type))
              .map(({ conname }) => conname),
          )
        expect(new Set(config.foreignKeys.map((key) => key.getName()))).toEqual(
          named('FOREIGN KEY'),
        )
        expect(
          new Set(config.uniqueConstraints.map(({ name }) => name)),
        ).toEqual(named('UNIQUE'))
        expect(new Set(config.checks.map(({ name }) => name))).toEqual(
          named('CHECK'),
        )
      }
    }).pipe(Effect.provide(database)),
  )
})

describe('the search indexes of the Drizzle schema', slow, () => {
  const declared = (options?: Parameters<typeof createSchema>[0]) =>
    getTableConfig(createSchema(options).tables.runs).indexes.map(
      ({ config }) => config,
    )
  const SEARCH = ['workflow_runs_input_gin_idx', 'workflow_runs_tags_gin_idx']

  it('are declared only when asked for', () => {
    const names = (options?: Parameters<typeof createSchema>[0]) =>
      declared(options).map(({ name }) => name)
    expect(names()).not.toEqual(expect.arrayContaining(SEARCH))
    expect(names({ searchIndexes: true })).toEqual(
      expect.arrayContaining([...names(), ...SEARCH]),
    )
  })

  it.live('serve the filters of a list of runs they are declared for', () =>
    Effect.gen(function* () {
      yield* Postgres.install
      for (const name of SEARCH) {
        const index = declared({ searchIndexes: true }).find(
          (config) => config.name === name,
        )!
        const [column] = index.columns as [
          { name: string; indexConfig: { opClass?: string } },
        ]
        // As declared: the method, the column and how it is indexed.
        yield* query(
          `CREATE INDEX ${name} ON workflow_runs
           USING ${index.method} (${column.name} ${column.indexConfig.opClass})`,
        )
        yield* query('SET enable_seqscan = off')
        // The condition a list puts on the column: containment.
        const plan = yield* query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT id FROM workflow_runs
           WHERE ${column.name} @> '{"tenant": "a"}'::jsonb`,
        )
        expect(plan.map((row) => row['QUERY PLAN']).join('\n')).toContain(name)
      }
    }).pipe(Effect.provide(database)),
  )
})

function adapter(real: boolean) {
  return (it: {
    readonly effect: Vitest.Tester<SqlClient.SqlClient | Scope.Scope>
  }) => {
    const test = <A, E>(
      name: string,
      body: Effect.Effect<A, E, Store | SqlClient.SqlClient | Scope.Scope>,
    ) => it.effect(name, () => Effect.provide(body, provided()))

    const locks = query<{ held: number }>(
      `SELECT count(*)::int AS held FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
    ).pipe(Effect.map(([row]) => row!.held))

    test(
      'a storage failure fails the commit, undoes it and spares the caller',
      Effect.gen(function* () {
        const store = yield* Store
        const sql = yield* SqlClient.SqlClient
        const orphan = '00000000-0000-4000-8000-00000000dead'
        const broken = store.transact({}, (snapshot) => {
          const run = stored(snapshot.id('run'), snapshot.now)
          return commit(
            {
              runs: [run],
              // No such run: the database refuses the command.
              enqueue: [
                {
                  command: continueRun({ ...run, id: orphan }),
                  dedupe: 'orphan',
                },
              ],
            },
            run.id,
          )
        })

        const error = storageFailure(yield* Effect.exit(broken))
        expect(error.reason._tag).toBe('ConstraintError')
        expect((error.reason.cause as { code: string }).code).toBe('23503')
        expect(yield* query('SELECT id FROM workflow_runs')).toEqual([])

        // In a caller's transaction the failure costs only its own commit:
        // what the caller did before and does after is committed.
        const [before, after] = yield* sql.withTransaction(
          Effect.gen(function* () {
            const before = yield* create
            storageFailure(yield* Effect.exit(broken))
            return [before, yield* create] as const
          }),
        )
        expect(
          (yield* query<{ id: string }>('SELECT id FROM workflow_runs')).map(
            ({ id }) => id,
          ),
        ).toEqual(expect.arrayContaining([before.id, after.id]))
        expect(yield* claim()).toHaveLength(2)
      }),
    )

    test(
      'reads time from the clock, not from the start of a transaction',
      Effect.gen(function* () {
        const store = yield* Store
        const sql = yield* SqlClient.SqlClient
        const [began, run, claimed] = yield* sql.withTransaction(
          Effect.gen(function* () {
            const [{ began }] = yield* query<{ began: Date }>(
              'SELECT now() AS began',
            ) as Effect.Effect<
              [{ began: Date }],
              SqlError.SqlError,
              SqlClient.SqlClient
            >
            yield* Effect.sleep('150 millis')
            // Inside the transaction `now()` still says when it began.
            const run = yield* create
            const claimed = yield* claim()
            return [began.getTime(), run, claimed] as const
          }),
        )

        expect(run.createdAt).toBeGreaterThanOrEqual(began + 150)
        // Due by the clock the claim read, and leased from that instant.
        expect(claimed).toHaveLength(1)
        const [row] = yield* query<{ run_at: Date; lease_expires_at: Date }>(
          'SELECT run_at, lease_expires_at FROM workflow_commands',
        )
        expect(row!.run_at.getTime()).toBe(run.createdAt)
        expect(row!.lease_expires_at.getTime()).toBeGreaterThanOrEqual(
          began + 150 + 60_000,
        )
        expect(yield* store.renew(claimed[0]!, 60_000)).toEqual(run)
      }),
    )

    test(
      'keeps what a release said and the commands that died',
      Effect.gen(function* () {
        const store = yield* Effect.andThen(
          SqlClient.SqlClient,
          fresh({ maxDeliveries: 1 }),
        )
        const run = yield* Effect.provideService(create, Store, store)
        const [claimed] = yield* Effect.provideService(claim(), Store, store)
        yield* store.release(claimed!, { error: new TypeError('no handler') })
        expect(yield* Effect.provideService(claim(), Store, store)).toEqual([])

        expect(
          yield* query(
            `SELECT run_id, kind, name, dedupe, delivery_count,
                    lease_token = '${claimed!.token}' AS claimed_once,
                    lease_expires_at IS NULL AS given_back,
                    last_error->>'name' AS error, last_error->>'message' AS message,
                    dead_at IS NOT NULL AS dead
             FROM workflow_commands`,
          ),
        ).toEqual([
          {
            run_id: run.id,
            kind: 'continueRun',
            name: 'flow',
            dedupe: `continue:${run.id}`,
            delivery_count: 1,
            // The token of its last claim stays, as the mark of one.
            claimed_once: true,
            given_back: true,
            error: 'TypeError',
            message: 'no handler',
            dead: true,
          },
        ])
      }),
    )

    test(
      'an id that is no uuid names nothing, and no claim',
      Effect.gen(function* () {
        const store = yield* Store
        expect(yield* store.load('nope')).toBeUndefined()
        const seen = yield* store.transact(
          { runs: ['run-1'], heads: ['run-2'] },
          (snapshot) => commit({}, snapshot),
        )
        expect(Array.from(seen.runs)).toEqual([['run-1', undefined]])
        expect(Array.from(seen.heads)).toEqual([['run-2', undefined]])

        const forged = {
          id: 'command-1',
          token: 'claim-1',
          command: continueRun({ id: 'run-1', name: 'flow' }),
          deliveries: 1,
        }
        const stale = new StaleClaim({ commandId: forged.id })
        expect(yield* Effect.flip(store.renew(forged, 1_000))).toEqual(stale)
        expect(yield* Effect.flip(store.release(forged))).toEqual(stale)
        expect(
          yield* Effect.flip(
            store.transact({}, () => commit({ ack: [forged] }, undefined)),
          ),
        ).toEqual(stale)
      }),
    )

    test(
      'in a caller transaction, only a commit keeps its guards, to the end',
      Effect.gen(function* () {
        const store = yield* Store
        const sql = yield* SqlClient.SqlClient
        const run = yield* create
        const [claimed] = yield* claim()
        yield* store.release(claimed!)

        const held = yield* sql.withTransaction(
          Effect.gen(function* () {
            const scope = { runs: [run.id], keys: ['k'] }
            // Refused, stale and broken: each is undone with its locks.
            yield* Effect.exit(
              store.transact(
                scope,
                (): Planned<never, string> => ({
                  _tag: 'Fail',
                  error: 'no',
                }),
              ),
            )
            yield* Effect.exit(
              store.transact(scope, () =>
                commit({ ack: [claimed!] }, undefined),
              ),
            )
            yield* Effect.exit(
              store.transact(scope, () => {
                throw new Error('broken plan')
              }),
            )
            const after = yield* locks

            // Widened twice on the way, each time from no lock at all.
            let calls = 0
            yield* store.transact(scope, (): Planned<undefined> => {
              calls += 1
              if (calls === 1) return { _tag: 'Need', scope: { keys: ['m'] } }
              if (calls === 2) {
                return { _tag: 'Need', scope: { definitions: ['d'] } }
              }
              return commit({}, undefined)
            })
            return [after, yield* locks] as const
          }),
        )

        expect(held).toEqual([0, 4])
        expect(yield* sql.withTransaction(locks)).toBe(0)
      }),
    )

    test(
      'refuses records of a run the plan did not load',
      Effect.gen(function* () {
        const store = yield* Store
        const run = yield* create
        const exit = yield* Effect.exit(
          store.transact({}, ({ now }) =>
            commit(
              {
                nodes: [
                  {
                    runId: run.id,
                    name: 'step',
                    kind: 'activity',
                    status: 'pending',
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              },
              undefined,
            ),
          ),
        )

        expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toBe(
          `Error: Unguarded write to [run:${run.id}]`,
        )
        expect((yield* store.load(run.id))?.nodes).toEqual([])
      }),
    )

    test(
      'hints are the commit’s: none before it, none for what is rolled back',
      Effect.gen(function* () {
        const store = yield* Store
        const sql = yield* SqlClient.SqlClient
        const hint = yield* store.hints(['continueRun'])
        const waiting = yield* Effect.forkScoped(hint)

        yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* create
              yield* Effect.sleep('150 millis')
              expect(waiting.pollUnsafe()).toBeUndefined()
              return yield* Effect.fail('rolled back' as const)
            }),
          ),
        )
        yield* Effect.sleep('150 millis')
        expect(waiting.pollUnsafe()).toBeUndefined()

        yield* sql.withTransaction(create)
        yield* Fiber.join(waiting).pipe(Effect.timeout('5 seconds'))
      }),
    )

    test(
      'a read the database refuses fails as a commit it refuses does',
      Effect.gen(function* () {
        const store = yield* Store
        const error = storageFailure(
          yield* Effect.exit(
            store.prunable({
              status: 'no-status' as never,
              updatedBefore: 0,
              limit: 1,
            }),
          ),
        )
        // 22P02: not a value of the enum.
        expect((error.reason.cause as { code: string }).code).toBe('22P02')
      }),
    )

    it.effect('refuses options that make no sense, when it is made', () =>
      Effect.gen(function* () {
        const refused = Effect.fnUntraced(function* (
          options: Postgres.PostgresOptions,
        ) {
          const exit = yield* Effect.exit(Postgres.make(options))
          return String(Exit.isFailure(exit) && Cause.squash(exit.cause))
        })
        for (const maxDeliveries of [0, -1, 1.5, Number.NaN]) {
          expect(yield* refused({ maxDeliveries })).toContain(
            `maxDeliveries [${maxDeliveries}] must be a positive integer`,
          )
        }
        // A longer name is cut by LISTEN and refused by pg_notify.
        for (const channel of ['', 'c'.repeat(64), 'é'.repeat(32)]) {
          expect(yield* refused({ channel })).toContain(
            `channel [${channel}] must be 1 to 63 bytes long`,
          )
        }
        for (const answerTimeoutMs of [0, -5, 0.5, 2 ** 31]) {
          expect(yield* refused({ answerTimeoutMs })).toContain(
            `answerTimeoutMs [${answerTimeoutMs}] must be a positive integer`,
          )
        }
        yield* Postgres.make({
          maxDeliveries: 1,
          channel: 'c'.repeat(63),
          answerTimeoutMs: 2 ** 31 - 1,
        })
      }),
    )

    test(
      'an id in another spelling of its uuid names nothing',
      Effect.gen(function* () {
        const store = yield* Store
        const run = yield* create
        const [claimed] = yield* claim()

        // A claim: the database would read the same uuid in capitals.
        const spelled = { ...claimed!, id: claimed!.id.toUpperCase() }
        const lost = new StaleClaim({ commandId: spelled.id })
        for (const part of ['ack', 'hold'] as const) {
          expect(
            yield* Effect.flip(
              store.transact({}, () => commit({ [part]: [spelled] }, 0)),
            ),
          ).toEqual(lost)
        }
        expect(yield* Effect.flip(store.release(spelled))).toEqual(lost)
        expect(yield* Effect.flip(store.renew(spelled, 60_000))).toEqual(lost)
        expect(
          yield* store.transact({ dead: [spelled.id] }, (snapshot) =>
            commit({}, snapshot.dead.get(spelled.id)),
          ),
        ).toBeUndefined()

        // A run: one made under such an id would be the run that is there.
        const upper = run.id.toUpperCase()
        const made = yield* Effect.exit(
          store.transact({}, ({ now }) =>
            commit({ runs: [stored(upper, now, { version: 5 })] }, 0),
          ),
        )
        expect(Exit.isFailure(made) && Cause.hasDies(made.cause)).toBe(true)
        expect((yield* store.load(run.id))?.run).toEqual(run)

        // The claim is held all the while, by the id it was given under.
        yield* store.transact({}, () => commit({ ack: [claimed!] }, 0))
        expect(yield* claim()).toEqual([])
      }),
    )

    test(
      'times written with microseconds read as whole milliseconds',
      Effect.gen(function* () {
        const store = yield* Store
        const run = yield* create
        const at = run.createdAt
        const step = { runId: run.id, version: 1, createdAt: at, updatedAt: at }
        const scope = {
          runs: [run.id],
          schedules: ['nightly'],
          scheduleNames: true,
        } as const
        yield* store.transact(scope, () =>
          commit(
            {
              nodes: [
                { ...step, name: 'step', kind: 'task', status: 'running' },
              ],
              children: [
                {
                  ...step,
                  nodeName: 'step',
                  childKey: '$self',
                  kind: 'task',
                  status: 'running',
                  attemptCount: 1,
                },
              ],
              attempts: [
                {
                  id: crypto.randomUUID(),
                  runId: run.id,
                  nodeName: 'step',
                  childKey: '$self',
                  status: 'completed',
                  attemptNumber: 1,
                  retryAttemptNumber: 1,
                  input: {},
                  dispatchedAt: at,
                  completedAt: at,
                },
              ],
              schedules: [
                {
                  name: 'nightly',
                  runnable: { kind: 'workflow', name: 'flow' },
                  input: 1,
                  tags: {},
                  everyMs: 60_000,
                  enabled: true,
                  nextRunAt: at,
                  lastSlotAt: at,
                  version: 1,
                  createdAt: at,
                  updatedAt: at,
                },
              ],
            },
            undefined,
          ),
        )
        // As an operator, a column default or the old engine writes them.
        yield* apply([
          `UPDATE workflow_runs SET active_since = '${MICROS}',
             created_at = '${MICROS}', updated_at = now()`,
          `UPDATE workflow_nodes
           SET created_at = '${MICROS}', updated_at = '${MICROS}'`,
          `UPDATE workflow_node_children
           SET created_at = '${MICROS}', updated_at = '${MICROS}'`,
          `UPDATE workflow_attempts
           SET dispatched_at = '${MICROS}', completed_at = '${MICROS}'`,
          `UPDATE workflow_schedules SET next_run_at = '${MICROS}',
             last_slot_at = '${MICROS}', created_at = '${MICROS}',
             updated_at = '${MICROS}'`,
          `UPDATE workflow_commands SET lease_token = 'dead',
             created_at = '${MICROS}', dead_at = '${MICROS}'`,
        ])
        const updatedAt = yield* floored('workflow_runs', 'updated_at')
        const times = { activeSince: MILLIS, createdAt: MILLIS, updatedAt }
        const nodeTimes = { createdAt: MILLIS, updatedAt: MILLIS }
        const schedule = {
          nextRunAt: MILLIS,
          lastSlotAt: MILLIS,
          createdAt: MILLIS,
          updatedAt: MILLIS,
        }
        const dead = { createdAt: MILLIS, deadAt: MILLIS }

        // Every read that gives records back gives them so.
        expect(yield* store.load(run.id)).toMatchObject({
          run: times,
          nodes: [nodeTimes],
          children: [nodeTimes],
          attempts: [{ dispatchedAt: MILLIS, completedAt: MILLIS }],
        })
        expect(yield* store.runs({ limit: 10 })).toMatchObject({
          items: [times],
        })
        expect(yield* store.schedules({ limit: 10 })).toMatchObject({
          items: [schedule],
        })
        const buried = yield* store.dead({ limit: 10 })
        expect(buried).toMatchObject({ items: [dead] })
        const deadId = buried.items[0]!.id
        const snapshot = yield* store.transact(
          {
            runs: [run.id],
            heads: [run.id],
            schedules: ['nightly'],
            dead: [deadId],
            families: [run.id],
          },
          (snapshot) => commit({}, snapshot),
        )
        expect(snapshot.runs.get(run.id)?.run).toMatchObject(times)
        expect(snapshot.heads.get(run.id)).toMatchObject(times)
        expect(snapshot.schedules.get('nightly')).toMatchObject(schedule)
        expect(snapshot.dead.get(deadId)).toMatchObject(dead)
        expect(snapshot.families.get(run.id)?.root).toMatchObject(times)
        // And `now` stays whole: the clock it reads has microseconds too.
        expect(Number.isInteger(snapshot.now)).toBe(true)
      }),
    )

    test(
      'a claim sets aside no more commands than twice its limit',
      Effect.gen(function* () {
        const store = yield* Effect.andThen(
          SqlClient.SqlClient,
          fresh({ maxDeliveries: 1 }),
        )
        const spent = 6
        const claimed = (limit: number, leaseMs = 60_000) =>
          store.claim({
            lanes: [{ kind: 'continueRun', routes: [{ name: 'flow' }] }],
            limit,
            leaseMs,
          })
        const dead = Effect.map(
          query<{ n: number }>(
            `SELECT count(*)::int AS n FROM workflow_commands
             WHERE dead_at IS NOT NULL`,
          ),
          ([row]) => row!.n,
        )
        const made = Effect.provideService(create, Store, store)
        // Six commands delivered once and lost, then one that is new.
        for (let n = 0; n < spent; n++) yield* made
        expect(yield* claimed(spent, 100)).toHaveLength(spent)
        yield* Effect.sleep('150 millis')
        const live = yield* made

        // Each claim reads the head of the lane, twice its limit of it, and
        // goes on from there the next time.
        for (let buried = 2; buried <= spent; buried += 2) {
          expect(yield* claimed(1)).toEqual([])
          expect(yield* dead).toBe(buried)
        }
        expect((yield* claimed(1)).map(({ command }) => command.runId)).toEqual(
          [live.id],
        )
      }),
    )

    if (!real) return

    test(
      'a claim reads the head of its lanes, not the queue',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        const owner = yield* create
        const taken = yield* claim()
        yield* store.transact({}, () => commit({ ack: taken }, undefined))
        // Thirty thousand commands of a lane the claim does not serve, and
        // five thousand of its own that are not due yet, all queued before
        // the one that is.
        yield* sql.unsafe(
          `INSERT INTO workflow_commands (kind, run_id, name, payload, dedupe, run_at)
           SELECT 'continueRun', $1::uuid, 'elsewhere', '{}', 'elsewhere:' || n, now()
           FROM generate_series(1, 30000) AS n`,
          [owner.id],
        )
        yield* sql.unsafe(
          `INSERT INTO workflow_commands (kind, run_id, name, payload, dedupe, run_at)
           SELECT 'continueRun', $1::uuid, 'flow', '{}', 'later:' || n, now() + interval '1 hour'
           FROM generate_series(1, 5000) AS n`,
          [owner.id],
        )
        const run = yield* create
        yield* sql.unsafe('ANALYZE workflow_commands')

        type Node = {
          readonly 'Node Type': string
          readonly 'Relation Name'?: string
          readonly 'Index Name'?: string
          readonly 'Actual Rows': number
          readonly 'Actual Loops': number
          readonly 'Rows Removed by Filter'?: number
          readonly Plans?: readonly Node[]
        }
        const [explained] = yield* sql.unsafe<{
          'QUERY PLAN': readonly [{ readonly Plan: Node }]
        }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${CLAIM}`, [
          JSON.stringify([
            { kind: 'continueRun', routes: [{ name: 'flow' }] },
            { kind: 'runTask', routes: [{ name: 'flow', revision: 'r1' }] },
          ]),
          1,
          60_000,
          20,
        ])
        const nodes = (node: Node): readonly Node[] => [
          node,
          ...(node.Plans ?? []).flatMap(nodes),
        ]
        const scans = nodes(explained!['QUERY PLAN'][0].Plan).filter(
          (node) => node['Relation Name'] === 'workflow_commands',
        )

        // No read of the table is of all of it, and the due ones are found
        // by the index of their lane.
        expect(
          scans.filter((node) => node['Node Type'] === 'Seq Scan'),
        ).toEqual([])
        expect(scans.map((node) => node['Index Name'])).toContain(
          'workflow_commands_lane_idx',
        )
        // And none reads more than the claim may take or set aside: what is
        // not due is passed over in the index.
        const read = scans.map(
          (node) =>
            node['Actual Rows'] * node['Actual Loops'] +
            (node['Rows Removed by Filter'] ?? 0),
        )
        expect(Math.max(...read)).toBeLessThanOrEqual(2)

        // It was the claim itself that was explained: the due one is taken.
        expect(
          yield* query(
            `SELECT dedupe FROM workflow_commands WHERE lease_token IS NOT NULL`,
          ),
        ).toEqual([{ dedupe: `continue:${run.id}` }])
      }),
    )

    test(
      'a statement the database does not answer in time fails its operation',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const run = yield* create
        const hurried = yield* Postgres.make({ answerTimeoutMs: 200 })
        const read = hurried.transact({ runs: [run.id] }, (snapshot) =>
          commit({}, snapshot.runs.get(run.id)?.run.version),
        )

        // The run's guard is held by a transaction that does not end.
        const holds = Latch.makeUnsafe()
        const ends = Latch.makeUnsafe()
        const holder = yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* bump(run.id)
              yield* holds.open
              yield* ends.await
            }),
          ),
        )
        yield* holds.await
        const error = storageFailure(yield* Effect.exit(read))
        expect(error.reason._tag).toBe('StatementTimeoutError')
        expect(error.reason.message).toBe(
          'PostgreSQL did not answer a workflow statement within 200 ms',
        )

        // The statement was cancelled, and its connection serves again.
        yield* ends.open
        yield* Fiber.join(holder)
        expect(yield* read).toBe(2)
      }),
    )

    test(
      'a run on its way into a family is counted before the family is removed',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        const root = yield* store.transact({}, (snapshot) => {
          const run = stored(snapshot.id('run'), snapshot.now, {
            status: 'completed',
          })
          return commit({ runs: [run] }, run)
        })

        // A run under the root is written, and its transaction not ended.
        const written = Latch.makeUnsafe()
        const commits = Latch.makeUnsafe()
        yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* store.transact({}, (snapshot) =>
                commit(
                  {
                    runs: [
                      stored(snapshot.id('run'), snapshot.now, {
                        parentRunId: root.id,
                        rootRunId: root.id,
                      }),
                    ],
                  },
                  undefined,
                ),
              )
              yield* written.open
              yield* commits.await
            }),
          ),
        )
        yield* written.await

        // The removal is planned on a family of one run that has ended.
        const views: (readonly [number, number])[] = []
        const removal = yield* Effect.forkScoped(
          store.transact({ families: [root.id] }, (snapshot) => {
            const { size, active } = snapshot.families.get(root.id)!
            views.push([size, active])
            return commit(active === 0 ? { remove: [root.id] } : {}, undefined)
          }),
        )
        yield* Effect.sleep('300 millis')
        expect(removal.pollUnsafe()).toBeUndefined()

        // It waited for the run, and is planned again on a family of two.
        yield* commits.open
        yield* Fiber.join(removal).pipe(Effect.timeout('5 seconds'))
        expect(views).toEqual([
          [1, 0],
          [2, 1],
        ])
        expect(
          yield* query('SELECT count(*)::int AS runs FROM workflow_runs'),
        ).toEqual([{ runs: 2 }])
      }),
    )

    test(
      'a run that wakes its parent unread never waits on the removal of its family',
      Effect.gen(function* () {
        // Shorter than the wait after which the database breaks a deadlock:
        // two transactions that wait on each other fail here instead.
        const [{ sooner }] = (yield* query<{ sooner: boolean }>(
          `SELECT current_setting('deadlock_timeout')::interval
             > interval '500 milliseconds' AS sooner`,
        )) as [{ sooner: boolean }]
        expect(sooner).toBe(true)
        const { store, inGap } = yield* gapped({ answerTimeoutMs: 500 })
        const ended = (patch?: Partial<StoredRun>) =>
          store.transact({}, (snapshot) => {
            const run = stored(snapshot.id('run'), snapshot.now, {
              status: 'completed',
              ...patch,
            })
            return commit({ runs: [run] }, run)
          })
        const root = yield* ended()
        const under = { rootRunId: root.id }
        const parent = yield* ended({ ...under, parentRunId: root.id })
        const run = yield* ended({ ...under, parentRunId: parent.id })

        // The removal locks the parent and waits for the run, which the last
        // pass of the run has loaded; that pass then queues the parent's.
        const removal = inGap!(
          Effect.orDie(
            store.transact({ families: [root.id] }, () =>
              commit({ remove: [root.id] }, undefined),
            ),
          ),
        )
        yield* store.transact({ runs: [run.id] }, (snapshot) =>
          commit(
            snapshot.runs.get(run.id)
              ? {
                  enqueue: [
                    {
                      command: continueRun(parent),
                      dedupe: `continue:${parent.id}`,
                    },
                  ],
                }
              : {},
            undefined,
          ),
        )
        expect(yield* removal).toBe(true)

        // The removal waited for the wake, then took it with the family.
        expect(
          yield* query(
            `SELECT (SELECT count(*)::int FROM workflow_runs) AS runs,
                    (SELECT count(*)::int FROM workflow_commands) AS commands`,
          ),
        ).toEqual([{ runs: 0, commands: 0 }])
      }),
    )

    test(
      'a load holds a root before a run under it that sorts first, as a removal does',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        // Ids made before generation 6 have no order: this run sorts before
        // its root.
        const rootId = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
        const runId = '00000000-0000-4000-8000-000000000000'
        yield* store.transact({}, (snapshot) =>
          commit(
            {
              runs: [
                stored(rootId, snapshot.now, { status: 'completed' }),
                stored(runId, snapshot.now, {
                  status: 'completed',
                  parentRunId: rootId,
                  rootRunId: rootId,
                }),
              ],
            },
            undefined,
          ),
        )

        // A removal's first statement: the root is held.
        const rootHeld = Latch.makeUnsafe()
        const loadWaits = Latch.makeUnsafe()
        const removal = yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`SELECT id FROM workflow_runs WHERE id = ${rootId}::uuid FOR UPDATE`
              yield* rootHeld.open
              yield* loadWaits.await
              // Its second: the run under the root, which a load that waits
              // for the root must not be holding.
              return yield* sql`SELECT id FROM workflow_runs WHERE id = ${runId}::uuid FOR UPDATE NOWAIT`.pipe(
                Effect.exit,
              )
            }),
          ),
        )
        yield* rootHeld.await

        // The run's pass, which holds the run's parent, the root, as well.
        const load = yield* Effect.forkScoped(
          store.transact({ runs: [runId] }, () => commit({}, undefined)),
        )
        yield* Effect.sleep('300 millis')
        expect(load.pollUnsafe()).toBeUndefined()
        yield* loadWaits.open

        expect(Exit.isSuccess(yield* Fiber.join(removal))).toBe(true)
        yield* Fiber.join(load).pipe(Effect.timeout('5 seconds'))
      }),
    )

    test(
      'removing a family waits for a writer of a run under it, then decides again',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        const root = yield* store.transact({}, (snapshot) => {
          const run = stored(snapshot.id('run'), snapshot.now, {
            status: 'completed',
          })
          return commit({ runs: [run] }, run)
        })
        const child = yield* store.transact({}, (snapshot) => {
          const run = stored(snapshot.id('run'), snapshot.now, {
            status: 'completed',
            parentRunId: root.id,
            rootRunId: root.id,
          })
          return commit({ runs: [run] }, run)
        })

        // Another transaction starts the child again and has not committed:
        // what the removal reads is the child as it was.
        const written = Latch.makeUnsafe()
        const commits = Latch.makeUnsafe()
        yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                `UPDATE workflow_runs SET status = 'running' WHERE id = $1`,
                [child.id],
              )
              yield* written.open
              yield* commits.await
            }),
          ),
        )
        yield* written.await
        const removal = yield* Effect.forkScoped(
          Effect.exit(Client.deleteRun(root.id)),
        )
        yield* Effect.sleep('200 millis')
        expect(removal.pollUnsafe()).toBeUndefined()

        yield* commits.open
        const exit = yield* Fiber.join(removal).pipe(
          Effect.timeout('5 seconds'),
        )
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toEqual(
          new RunBusy({ runId: root.id, busyRunId: child.id }),
        )
        expect(
          yield* query('SELECT count(*)::int AS runs FROM workflow_runs'),
        ).toEqual([{ runs: 2 }])
      }),
    )

    test(
      'a writer waits for what an open transaction has loaded',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const run = yield* create
        // Forked outside: a fiber forked in a transaction is part of it.
        const loaded = Latch.makeUnsafe()
        const writer = yield* Effect.forkScoped(
          Effect.andThen(loaded.await, bump(run.id)),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* bump(run.id)
            yield* loaded.open
            // The caller has not committed: its bump is not there to read,
            // so nobody may plan on the run until it is.
            yield* Effect.sleep('300 millis')
            expect(writer.pollUnsafe()).toBeUndefined()
          }),
        )

        yield* Fiber.join(writer)
        expect((yield* Client.get(run.id))?.run.version).toBe(3)
      }),
    )

    test(
      'an interrupted transact that waits for a guard applies nothing',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const run = yield* create
        const loaded = Latch.makeUnsafe()
        const writer = yield* Effect.forkScoped(
          Effect.andThen(loaded.await, bump(run.id)),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* bump(run.id)
            yield* loaded.open
            yield* Effect.sleep('200 millis')
            // Waiting on the guard; the wait ends with the interruption.
            yield* Fiber.interrupt(writer)
          }),
        )

        expect((yield* Client.get(run.id))?.run.version).toBe(2)
        // Its connection and its lock went back: the next writer is served.
        yield* bump(run.id)
        expect((yield* Client.get(run.id))?.run.version).toBe(3)
      }),
    )

    test(
      'transactions that need each other’s runs never wait on each other',
      Effect.gen(function* () {
        const store = yield* Store
        const sql = yield* SqlClient.SqlClient
        const deadlocks = sql.unsafe<{ deadlocks: number }>(
          `SELECT deadlocks::int FROM pg_stat_database
           WHERE datname = current_database()`,
        )
        const [before] = yield* deadlocks
        const pairs = yield* Effect.all(
          Array.from({ length: 8 }, () => Effect.all([create, create])),
        )

        // Each starts from its own run and then needs the other: the shape
        // of a child's last pass against its parent's.
        const both = (own: StoredRun, other: StoredRun) =>
          store.transact({ runs: [own.id] }, (snapshot) => {
            const head = snapshot.heads.get(other.id)
            if (!head) return { _tag: 'Need', scope: { heads: [other.id] } }
            const { run } = snapshot.runs.get(own.id)!
            return commit(
              {
                runs: [
                  { ...run, version: run.version + 1 },
                  { ...head, version: head.version + 1 },
                ],
              },
              undefined,
            )
          })
        const rounds = 5
        yield* Effect.all(
          pairs.flatMap(([parent, child]) =>
            Array.from({ length: rounds }, () => [
              both(parent, child),
              both(child, parent),
            ]).flat(),
          ),
          { concurrency: 'unbounded' },
        )

        for (const run of pairs.flat()) {
          expect((yield* Client.get(run.id))?.run.version).toBe(1 + 2 * rounds)
        }
        // The database counts deadlocks, and reports the count late.
        yield* Effect.sleep('1500 millis')
        expect(yield* deadlocks).toEqual([before])
      }),
    )

    test(
      'a claimer skips what another is claiming instead of waiting for it',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const [first, second] = [yield* create, yield* create]
        const claimed = Latch.makeUnsafe()
        const other = yield* Effect.forkScoped(
          Effect.andThen(claimed.await, claim(10)),
        )
        const [mine, theirs] = yield* sql.withTransaction(
          Effect.gen(function* () {
            // Claimed, and the claim not committed: its row is locked.
            const mine = yield* claim(1)
            yield* claimed.open
            const theirs = yield* Fiber.join(other).pipe(
              Effect.timeout('5 seconds'),
            )
            return [mine, theirs] as const
          }),
        )

        expect(mine.map(({ command }) => command.runId)).toEqual([first.id])
        expect(theirs.map(({ command }) => command.runId)).toEqual([second.id])
      }),
    )

    /**
     * Holds the row of a command for `ms`, unchanged, in a transaction of
     * its own: whoever wants the row meanwhile waits, and finds it as it was.
     */
    const holdRow = Effect.fnUntraced(function* (id: string, ms: number) {
      const sql = yield* SqlClient.SqlClient
      const had = Latch.makeUnsafe()
      const holder = yield* Effect.forkScoped(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(
              'SELECT FROM workflow_commands WHERE id = $1::uuid FOR UPDATE',
              [id],
            )
            yield* had.open
            yield* Effect.sleep(ms)
          }),
        ),
      )
      yield* had.await
      return holder
    })
    const claimFor = (leaseMs: number) =>
      Effect.flatMap(Store, (store) =>
        store.claim({
          lanes: [{ kind: 'continueRun', routes: [{ name: 'flow' }] }],
          limit: 1,
          leaseMs,
        }),
      )

    test(
      'a claim whose lease ended while its row was waited for is stale',
      Effect.gen(function* () {
        const store = yield* Store
        yield* create
        const asked = {
          hold: (claimed) =>
            store.transact({}, () => commit({ hold: [claimed] }, 0)),
          ack: (claimed) =>
            store.transact({}, () => commit({ ack: [claimed] }, 0)),
          release: (claimed) => store.release(claimed),
          renew: (claimed) => store.renew(claimed, 60_000),
        } satisfies Record<
          string,
          (claimed: Claim) => Effect.Effect<unknown, StaleClaim | StorageError>
        >

        for (const [how, ask] of Object.entries(asked)) {
          // Asked while the lease holds, answered when it has ended: the
          // row comes back as it was, and the claim on it is over.
          const [claimed] = yield* claimFor(200)
          const holder = yield* holdRow(claimed!.id, 500)
          expect(yield* Effect.flip(ask(claimed!)), how).toEqual(
            new StaleClaim({ commandId: claimed!.id }),
          )
          yield* Fiber.join(holder)
        }
        // Nothing of them was applied: the command is there, to be claimed.
        expect(yield* claimFor(60_000)).toMatchObject([{ deliveries: 5 }])
      }),
    )

    test(
      'a plan of a unit whose claim ended while it waited for the run is stale',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        const run = yield* create
        const [claimed] = yield* claimFor(200)
        // The run's guard, held for longer than the lease by a transaction
        // of its own: the plan of the unit waits for it.
        const had = Latch.makeUnsafe()
        const holder = yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                [`run:${run.id}`],
              )
              yield* had.open
              yield* Effect.sleep('500 millis')
            }),
          ),
        )
        yield* had.await

        const unit = { runId: run.id, nodeName: 'step', childKey: '$self' }
        const stale = yield* Effect.flip(
          store.transact({ units: [unit] }, (snapshot) => {
            const { run: found } = snapshot.units.get(unitKey(unit))!
            return commit(
              {
                ack: [claimed!],
                runs: [{ ...found!, version: found!.version + 1 }],
              },
              0,
            )
          }),
        )
        expect(stale).toEqual(new StaleClaim({ commandId: claimed!.id }))
        yield* Fiber.join(holder)
        expect((yield* Client.get(run.id))?.run.version).toBe(1)
      }),
    )

    test(
      'a renewal that waited for the row holds for its lease from then',
      Effect.gen(function* () {
        const store = yield* Store
        yield* create
        const [claimed] = yield* claimFor(2_000)
        const holder = yield* holdRow(claimed!.id, 500)
        yield* store.renew(claimed!, 400)
        yield* Fiber.join(holder)

        // Counted from when it was asked for, the lease would be over.
        yield* store.transact({}, () => commit({ hold: [claimed!] }, 0))
        yield* Effect.sleep('500 millis')
        expect(
          yield* Effect.flip(
            store.transact({}, () => commit({ hold: [claimed!] }, 0)),
          ),
        ).toEqual(new StaleClaim({ commandId: claimed!.id }))
      }),
    )

    test(
      'a command not added for one that is not committed yet makes that one due no later',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        const run = yield* create
        const taken = yield* claim()
        yield* store.transact({}, () => commit({ ack: taken }, 0))
        const wake = (inMs?: number) =>
          store.transact({}, ({ now }) =>
            commit(
              {
                enqueue: [
                  {
                    command: continueRun(run),
                    dedupe: `continue:${run.id}`,
                    ...(inMs === undefined ? {} : { availableAt: now + inMs }),
                  },
                ],
              },
              0,
            ),
          )
        const hint = yield* store.hints(['continueRun'])

        // Queued for a minute from now, in a transaction that has not ended.
        const queued = Latch.makeUnsafe()
        const commits = Latch.makeUnsafe()
        const far = yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* wake(60_000)
              yield* queued.open
              yield* commits.await
            }),
          ),
        )
        yield* queued.await
        // Wanted at once: it cannot see the other, and meets it at the index.
        const near = yield* Effect.forkScoped(wake())
        yield* Effect.sleep('300 millis')
        expect(near.pollUnsafe()).toBeUndefined()
        yield* commits.open
        yield* Fiber.join(far)
        yield* Fiber.join(near)

        // One command, due now, and announced.
        yield* hint.pipe(Effect.timeout('5 seconds'))
        expect((yield* claim()).map(({ command }) => command.runId)).toEqual([
          run.id,
        ])
        expect(
          yield* query(
            'SELECT count(*)::int AS commands FROM workflow_commands',
          ),
        ).toEqual([{ commands: 1 }])
      }),
    )

    test(
      'shows an open read the runs its children started while it waited for the run',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        const run = yield* create
        const started = yield* create
        // A pass of the run that starts a child, and has not committed.
        const linked = Latch.makeUnsafe()
        const commits = Latch.makeUnsafe()
        const writer = yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* store.transact({ runs: [run.id] }, ({ now }) => {
                const record = {
                  runId: run.id,
                  version: 1,
                  createdAt: now,
                  updatedAt: now,
                } as const
                return commit(
                  {
                    nodes: [
                      {
                        ...record,
                        name: 'each',
                        kind: 'mapTask',
                        status: 'running',
                        input: [0],
                      },
                    ],
                    children: [
                      {
                        ...record,
                        nodeName: 'each',
                        childKey: 'item:0',
                        kind: 'task',
                        status: 'waiting',
                        ordinal: 0,
                        item: 0,
                        attemptCount: 0,
                        childRunId: started.id,
                      },
                    ],
                  },
                  undefined,
                )
              })
              yield* linked.open
              yield* commits.await
            }),
          ),
        )
        yield* linked.await
        // It chooses the runs to guard before it waits, when there were none.
        const shown: unknown[] = []
        const reader = yield* Effect.forkScoped(
          store.transact(
            {
              open: [
                {
                  runId: run.id,
                  maps: [{ nodeName: 'each', pendingLimit: 1 }],
                },
              ],
            },
            (snapshot) => {
              shown.push(snapshot.open.get(run.id)?.linked.get(started.id))
              return commit({}, undefined)
            },
          ),
        )
        yield* Effect.sleep('300 millis')
        expect(shown).toEqual([])
        yield* commits.open
        yield* Fiber.join(writer)
        yield* Fiber.join(reader)

        // On its first plan, guarded: no transaction of its own to ask for it.
        expect(shown).toEqual([started])
      }),
    )

    const passedOver = (laterBy?: number) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const store = yield* Store
        const run = yield* create
        const taken = yield* claim()
        yield* store.transact({}, () => commit({ ack: taken }, 0))
        const wake = (later?: number) =>
          store.transact({}, (snapshot) =>
            commit(
              {
                enqueue: [
                  {
                    command: continueRun(run),
                    dedupe: `continue:${run.id}`,
                    ...(later === undefined
                      ? {}
                      : { availableAt: snapshot.now + later }),
                  },
                ],
              },
              0,
            ),
          )
        // Two wakes of one run, as two of its children ending at once queue
        // them: each in a transaction that has not ended.
        const pending = (later?: number) =>
          Effect.gen(function* () {
            const queued = Latch.makeUnsafe()
            const commits = Latch.makeUnsafe()
            const fiber = yield* Effect.forkScoped(
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* wake(later)
                  yield* queued.open
                  yield* commits.await
                }),
              ),
            )
            return { fiber, queued, commits }
          })
        const first = yield* pending()
        yield* first.queued.await
        // It cannot see the first, and waits for it at the index.
        const second = yield* pending(laterBy)
        yield* Effect.sleep('300 millis')
        expect(second.queued.isOpen()).toBe(false)

        const hint = yield* store.hints(['continueRun'])
        yield* first.commits.open
        yield* Fiber.join(first.fiber)
        yield* hint.pipe(Effect.timeout('2 seconds'))
        // Met there, the command is held by the second until it ends: the
        // claimer the first woke passes over it.
        yield* second.queued.await
        expect(yield* claim()).toEqual([])

        const woken = yield* Effect.forkScoped(hint)
        yield* second.commits.open
        yield* Fiber.join(second.fiber)
        // So the second tells of it too, or nobody looks until the poll.
        yield* Fiber.join(woken).pipe(Effect.timeout('2 seconds'))
        expect((yield* claim()).map(({ command }) => command.runId)).toEqual([
          run.id,
        ])
      })

    test(
      'a command not added for one that waits due hints it again, which a claim may have passed over',
      passedOver(),
    )

    test(
      'a command wanted later and not added for one that waits due hints it all the same',
      passedOver(60_000),
    )
  }
}

layer(pglite, options)('the adapter on PGlite', adapter(false))

describe.skipIf(!POSTGRES_URL)('the adapter on PostgreSQL', () => {
  layer(postgres(POSTGRES_URL!), options)(adapter(true))
})

describe('hints', slow, () => {
  const served = {
    workflows: [Billing, ManualBilling],
    tasks: [CreateInvoice, RequestApproval, RecordPayment],
  }
  const order = { id: 'o-1', mode: 'manual' as const, cents: 500 }
  const ended = (runId: string) =>
    Effect.gen(function* () {
      for (;;) {
        const records = yield* Client.get(runId)
        if (records && isTerminal(records.run.status)) return records.run
        yield* Effect.sleep('20 millis')
      }
    }).pipe(Effect.timeout('30 seconds'), Effect.orDie)
  const workers = (pollMs: number) =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(Worker.coordinator({ ...served, pollMs }))
      yield* Effect.forkScoped(Worker.execution({ ...served, pollMs }))
    })
  /** The schema and no listener: what a deployment without one provides. */
  const silent = Layer.provideMerge(
    Layer.effectDiscard(Effect.orDie(Postgres.install)),
    database,
  )

  it.live('without a listener none is given, and workers poll', () =>
    Effect.gen(function* () {
      const store = yield* Store
      const hint = yield* store.hints(['continueRun'])
      const waiting = yield* Effect.forkScoped(hint)
      yield* workers(50)

      const run = yield* Client.start(Billing, order)
      expect((yield* ended(run.id)).status).toBe('completed')
      expect(waiting.pollUnsafe()).toBeUndefined()
    }).pipe(
      Effect.provide(Layer.provideMerge(Postgres.layer(), silent)),
      Effect.scoped,
    ),
  )

  it.live('a listener that is lost is found again, and says so', () =>
    Effect.gen(function* () {
      const listened: string[] = []
      let wake: (() => void) | undefined
      // Fails on the first try, as a database that is not up yet would.
      const flaky = Postgres.Notifications.of({
        listen: (channel) =>
          Effect.suspend(() => {
            listened.push(channel)
            if (listened.length === 1) {
              return Effect.fail(
                new SqlError.SqlError({
                  reason: new SqlError.ConnectionError({
                    message: 'not yet',
                    operation: 'listen',
                    cause: undefined,
                  }),
                }),
              )
            }
            return Effect.succeed(
              Effect.callback<string, SqlError.SqlError>((resume) => {
                wake = () => resume(Effect.succeed('kind:continueRun'))
              }),
            )
          }),
      })
      const store = yield* Effect.provideService(
        Postgres.make(),
        Postgres.Notifications,
        flaky,
      )
      const hint = yield* store.hints(['continueRun'])

      // Built all the same: a store that cannot listen yet is one that polls.
      expect(listened).toEqual([Postgres.CHANNEL])
      yield* Effect.sleep('1200 millis')
      expect(listened).toEqual([Postgres.CHANNEL, Postgres.CHANNEL])
      // Listening again, it wakes everyone once: what was missed is unknown.
      yield* hint

      const next = yield* Effect.forkScoped(hint)
      yield* Effect.sleep('50 millis')
      expect(next.pollUnsafe()).toBeUndefined()
      wake!()
      yield* Fiber.join(next)
    }).pipe(Effect.provide(silent), Effect.scoped),
  )
})
