import { randomUUID } from 'node:crypto'

import * as PgClient from '@effect/sql-pg/PgClient'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlError from 'effect/sql/SqlError'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { WorkflowRuntimeClient } from '../../src/runtime/index.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../../src/adapters/postgres.ts'
import { WORKFLOW_RUN_EVENTS_CHANNEL } from '../../src/adapters/postgres/sql.ts'
import { installPostgresWorkflowSchemaForTesting } from '../../src/adapters/postgres/testing.ts'
import { defineTask, defineWorkflow } from '../../src/effect/index.ts'
import { createEffectSqlWorkflowClient } from '../../src/effect/postgres.ts'
import {
  createWorkflowRuntimeClient,
  WorkflowIdempotencyConflictError,
  WorkflowRunConflictError,
} from '../../src/runtime/index.ts'
import { postgresTarget, requireServiceEnv, wait } from './helpers.ts'

requireServiceEnv(postgresTarget)

const workflow = defineWorkflow({
  name: 'effect-sql-start-workflow',
  input: Schema.Struct({ value: Schema.String }),
}).build()

const task = defineTask({
  name: 'effect-sql-start-task',
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({}),
})

class Abort extends Error {}

describe.skipIf(!postgresTarget.url)(
  '@nmtjs/workflows Postgres start inside an Effect SQL transaction',
  () => {
    // The database is shared and other specs truncate its workflow tables, so
    // this spec works in a schema of its own.
    const schema = `effect_sql_${randomUUID().replaceAll('-', '')}`
    const searchPath = `${schema},public`
    let pool!: pg.Pool
    let runtime!: ManagedRuntime.ManagedRuntime<
      SqlClient.SqlClient,
      SqlError.SqlError
    >
    // Counts what the workflow pool lends, to prove a joined start takes no
    // session of its own.
    let poolUses = 0
    let client!: WorkflowRuntimeClient<WorkflowPostgresConnection>
    let effectClient!: ReturnType<typeof createEffectSqlWorkflowClient>

    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      runtime.runPromise(effect)
    const runExit = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      runtime.runPromiseExit(effect)

    const count = async (
      table: string,
      where = 'true',
      params: unknown[] = [],
    ) =>
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${table} WHERE ${where}`,
          params,
        )
      ).rows[0]!.count

    const insertSample = (id: number) =>
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`INSERT INTO sample (id) VALUES (${id})`,
      )

    const lockWaiters = async (table = 'workflow_runs') =>
      (
        await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND query LIKE '%' || $1 || '%'
             AND pid <> pg_backend_pid()`,
          [table],
        )
      ).rows[0]!.count

    // Holds an ACCESS EXCLUSIVE lock on a workflow table from another session.
    const lockTable = async (table: string) => {
      const locker = await pool.connect()
      await locker.query('BEGIN')
      await locker.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`)
      return async () => {
        await locker.query('ROLLBACK')
        locker.release()
      }
    }

    const sampleId = () => Math.floor(Math.random() * 2 ** 31)

    beforeAll(async () => {
      const admin = new pg.Client({ connectionString: postgresTarget.url })
      await admin.connect()
      try {
        await admin.query(`CREATE SCHEMA ${schema}`)
      } finally {
        await admin.end()
      }

      pool = new pg.Pool({
        connectionString: postgresTarget.url,
        options: `-c search_path=${searchPath}`,
        max: 4,
      })

      const setup = createPostgresWorkflowConnection(pool)
      await installPostgresWorkflowSchemaForTesting(setup)
      await setup.query('CREATE TABLE sample (id integer PRIMARY KEY)')

      const counted = {
        totalCount: 0,
        query: (sql: string, params?: readonly unknown[]) => {
          poolUses++
          return pool.query(sql, params ? [...params] : undefined)
        },
        connect: () => {
          poolUses++
          return pool.connect()
        },
      } as unknown as pg.Pool
      client = createWorkflowRuntimeClient({
        ...createPostgresWorkflowRuntime({
          connection: createPostgresWorkflowConnection(counted),
        }),
        definitions: [workflow, task],
      })

      effectClient = createEffectSqlWorkflowClient(client)
      runtime = ManagedRuntime.make(
        PgClient.layer({
          url: Redacted.make(postgresTarget.url!),
          startupParameters: { search_path: searchPath },
          maxConnections: 4,
        }),
      )
    })

    afterEach(() => {
      poolUses = 0
    })

    afterAll(async () => {
      await runtime?.dispose()
      await pool?.end()
      const admin = new pg.Client({ connectionString: postgresTarget.url })
      await admin.connect()
      try {
        await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      } finally {
        await admin.end()
      }
    })

    it('commits the run, its dispatch and its wake with the caller, on the caller session', async () => {
      const listener = new pg.Client({ connectionString: postgresTarget.url })
      await listener.connect()
      const wakes: string[] = []
      listener.on('notification', (message) => {
        if (message.payload) wakes.push(message.payload)
      })

      await listener.query(`LISTEN ${WORKFLOW_RUN_EVENTS_CHANNEL}`)
      try {
        const id = sampleId()
        let wakesBeforeCommit = -1
        let visibleOutside = -1
        const started = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* insertSample(id)
                const started = yield* effectClient.start(workflow, {
                  value: 'commit',
                })

                const inside = yield* sql<{
                  count: number
                }>`SELECT count(*)::int AS count FROM workflow_runs WHERE id = ${started.id}`
                expect(inside[0]!.count).toBe(1)
                yield* Effect.promise(async () => {
                  await wait(100)
                  wakesBeforeCommit = wakes.filter(
                    (wake) => wake === started.id,
                  ).length
                  visibleOutside = await count('workflow_runs', 'id = $1', [
                    started.id,
                  ])
                })

                return started
              }),
            )
          }),
        )

        expect(started.input).toEqual({ value: 'commit' })
        expect(wakesBeforeCommit).toBe(0)
        expect(visibleOutside).toBe(0)
        expect(poolUses).toBe(0)
        expect(await count('sample', 'id = $1', [id])).toBe(1)
        expect(await count('workflow_runs', 'id = $1', [started.id])).toBe(1)
        expect(
          await count('workflow_commands', 'run_id = $1', [started.id]),
        ).toBe(1)
        await expect
          .poll(() => wakes.filter((wake) => wake === started.id).length)
          .toBeGreaterThan(0)
      } finally {
        await listener.end()
      }
    })

    it('leaves no run and no dispatch when the caller rolls back', async () => {
      const id = sampleId()
      let runId: string | undefined
      const exit = await runExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* insertSample(id)
              const started = yield* effectClient.start(task, {
                value: 'rollback',
              })

              runId = started.id
              return yield* Effect.fail(new Abort())
            }),
          )
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(runId).toBeDefined()
      expect(poolUses).toBe(0)
      expect(await count('sample', 'id = $1', [id])).toBe(0)
      expect(await count('workflow_runs', 'id = $1', [runId])).toBe(0)
      expect(await count('workflow_commands', 'run_id = $1', [runId])).toBe(0)
    })

    it('leaves no run when a later statement of the caller fails', async () => {
      const id = sampleId()
      let runId: string | undefined
      const exit = await runExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const started = yield* effectClient.start(workflow, {
                value: 'later-failure',
              })

              runId = started.id
              yield* insertSample(id)
              yield* insertSample(id)
            }),
          )
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(runId).toBeDefined()
      expect(await count('sample', 'id = $1', [id])).toBe(0)
      expect(await count('workflow_runs', 'id = $1', [runId])).toBe(0)
    })

    it('cancels a blocked start on interruption and rolls the caller back', async () => {
      const id = sampleId()
      const locker = await pool.connect()
      try {
        await locker.query('BEGIN')
        await locker.query('LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE')

        const fiber = runtime.runFork(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* insertSample(id)
                return yield* effectClient.start(workflow, {
                  value: 'interrupted',
                })
              }),
            )
          }),
        )

        await expect.poll(() => lockWaiters()).toBeGreaterThan(0)

        // Settles while the lock is still held: the start's statement was
        // cancelled on the server rather than awaited.
        const exit = await Effect.runPromise(
          Fiber.interrupt(fiber).pipe(
            Effect.andThen(Fiber.await(fiber)),
            Effect.timeout('5 seconds'),
          ),
        )

        expect(Exit.hasInterrupts(exit)).toBe(true)
      } finally {
        await locker.query('ROLLBACK')
        locker.release()
      }

      // A start that kept waiting would write as soon as the lock is gone.
      await expect.poll(() => lockWaiters()).toBe(0)
      expect(poolUses).toBe(0)
      expect(await count('sample', 'id = $1', [id])).toBe(0)
      expect(
        await count('workflow_runs', "input->>'value' = 'interrupted'"),
      ).toBe(0)
      // The Effect pool session is clean for the next borrower.
      await run(insertSample(id))
      expect(await count('sample', 'id = $1', [id])).toBe(1)
    })

    it('rolls back an interrupted start while the caller carries on and commits', async () => {
      const id = sampleId()
      // The run insert goes through; its dispatch then waits on this lock.
      const unlock = await lockTable('workflow_commands')
      try {
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  effectClient.start(workflow, { value: 'child-interrupted' }),
                )

                yield* Effect.promise(() =>
                  expect
                    .poll(() => lockWaiters('workflow_commands'))
                    .toBeGreaterThan(0),
                )

                yield* Fiber.interrupt(fiber)
                yield* insertSample(id)
              }),
            )
          }),
        )
      } finally {
        await unlock()
      }

      expect(await count('sample', 'id = $1', [id])).toBe(1)
      expect(
        await count('workflow_runs', "input->>'value' = 'child-interrupted'"),
      ).toBe(0)
    })

    it('keeps every run of concurrent starts in one transaction', async () => {
      const key = ['effect-sql-concurrent', randomUUID()]
      await client.start(
        workflow,
        { value: 'concurrent-holder' },
        { unique: { key } },
      )

      const outcomes = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.all(
              Array.from({ length: 6 }, (_, index) =>
                index % 2 === 0
                  ? Effect.map(
                      effectClient.start(workflow, {
                        value: 'concurrent-ok',
                      }),
                      (run) => run.id,
                    )
                  : Effect.flip(
                      effectClient.start(
                        workflow,
                        { value: 'concurrent-duplicate' },
                        { unique: { key } },
                      ),
                    ),
              ),
              { concurrency: 'unbounded' },
            ),
          )
        }),
      )

      const started = outcomes.filter(
        (outcome): outcome is string => typeof outcome === 'string',
      )

      expect(started).toHaveLength(3)
      for (const conflict of outcomes.filter(
        (outcome) => typeof outcome !== 'string',
      )) {
        expect(conflict).toBeInstanceOf(WorkflowRunConflictError)
      }

      expect(
        await count('workflow_runs', 'id = ANY($1::uuid[])', [started]),
      ).toBe(3)
      expect(
        await count('workflow_commands', 'run_id = ANY($1::uuid[])', [started]),
      ).toBe(3)
    })

    it('fails a unique conflict as a typed error and keeps the transaction usable', async () => {
      const key = ['effect-sql-unique', randomUUID()]
      const holder = await client.start(
        workflow,
        { value: 'holder' },
        { unique: { key } },
      )

      poolUses = 0
      const before = sampleId()
      const after = sampleId()

      const conflict = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* insertSample(before)
              const error = yield* Effect.flip(
                effectClient.start(
                  workflow,
                  { value: 'duplicate' },
                  { unique: { key } },
                ),
              )

              yield* insertSample(after)
              return error
            }),
          )
        }),
      )

      expect(poolUses).toBe(0)
      expect(conflict).toBeInstanceOf(WorkflowRunConflictError)
      expect((conflict as WorkflowRunConflictError).runId).toBe(holder.id)
      expect(await count('sample', 'id IN ($1, $2)', [before, after])).toBe(2)
      expect(
        await count('workflow_runs', "input->>'value' = 'duplicate'"),
      ).toBe(0)
    })

    it('fails an idempotency conflict as a typed error and keeps the transaction usable', async () => {
      const idempotencyKey = ['effect-sql-idempotent', randomUUID()]
      await client.start(workflow, { value: 'first' }, { idempotencyKey })
      poolUses = 0
      const id = sampleId()

      const conflict = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const error = yield* Effect.flip(
                effectClient.start(
                  workflow,
                  { value: 'second' },
                  { idempotencyKey },
                ),
              )

              yield* insertSample(id)
              return error
            }),
          )
        }),
      )

      expect(poolUses).toBe(0)
      expect(conflict).toBeInstanceOf(WorkflowIdempotencyConflictError)
      expect(await count('sample', 'id = $1', [id])).toBe(1)
    })

    it('fails a statement past answerTimeoutMs as a typed SqlError and keeps the transaction usable', async () => {
      const bounded = createEffectSqlWorkflowClient(client, {
        answerTimeoutMs: 200,
      })

      const id = sampleId()
      const locker = await pool.connect()
      let error: unknown
      try {
        await locker.query('BEGIN')
        await locker.query('LOCK TABLE workflow_runs IN ACCESS EXCLUSIVE MODE')
        error = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const error = yield* Effect.flip(
                  bounded.start(workflow, { value: 'deadline' }),
                )

                yield* insertSample(id)
                return error
              }),
            )
          }),
        )
      } finally {
        await locker.query('ROLLBACK')
        locker.release()
      }

      expect(SqlError.isSqlError(error)).toBe(true)
      expect((error as SqlError.SqlError).reason._tag).toBe(
        'StatementTimeoutError',
      )

      expect(await count('sample', 'id = $1', [id])).toBe(1)
      expect(await count('workflow_runs', "input->>'value' = 'deadline'")).toBe(
        0,
      )
    })

    it('restarts a terminal run inside the caller transaction', async () => {
      const original = await client.start(task, { value: 'restart' })
      await client.cancel(original.id)
      poolUses = 0

      const rolledBack = await runExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.andThen(
              effectClient.restart(original.id),
              Effect.fail(new Abort()),
            ),
          )
        }),
      )

      expect(Exit.isFailure(rolledBack)).toBe(true)
      expect(await count('workflow_runs', "input->>'value' = 'restart'")).toBe(
        1,
      )

      const restarted = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(effectClient.restart(original.id))
        }),
      )

      expect(restarted.id).not.toBe(original.id)
      expect(poolUses).toBe(0)
      expect(await count('workflow_runs', "input->>'value' = 'restart'")).toBe(
        2,
      )
    })

    it('keeps the transaction usable when the restart read fails', async () => {
      const bounded = createEffectSqlWorkflowClient(client, {
        answerTimeoutMs: 200,
      })

      const original = await client.start(task, { value: 'restart-read' })
      await client.cancel(original.id)
      const id = sampleId()
      const unlock = await lockTable('workflow_runs')
      let error: unknown
      try {
        error = await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const error = yield* Effect.flip(bounded.restart(original.id))
                yield* insertSample(id)
                return error
              }),
            )
          }),
        )
      } finally {
        await unlock()
      }

      expect(SqlError.isSqlError(error)).toBe(true)
      expect(await count('sample', 'id = $1', [id])).toBe(1)
    })

    const runStatus = async (runId: string) =>
      (
        await pool.query<{ status: string }>(
          'SELECT status::text AS status FROM workflow_runs WHERE id = $1',
          [runId],
        )
      ).rows[0]?.status

    it('commits a cancellation with the caller, on the caller session', async () => {
      const queued = await client.start(task, { value: 'cancel-commit' })
      poolUses = 0
      const id = sampleId()
      let statusOutside: string | undefined

      const cancelled = await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* insertSample(id)
              const cancelled = yield* effectClient.cancel(queued.id)
              statusOutside = yield* Effect.promise(() => runStatus(queued.id))
              return cancelled
            }),
          )
        }),
      )

      expect(cancelled?.status).toBe('cancelled')
      expect(statusOutside).toBe('queued')
      expect(poolUses).toBe(0)
      expect(await runStatus(queued.id)).toBe('cancelled')
      expect(await count('sample', 'id = $1', [id])).toBe(1)
    })

    it('leaves the run untouched when the caller rolls back a cancellation', async () => {
      const queued = await client.start(workflow, { value: 'cancel-rollback' })

      const exit = await runExit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const cancelling = yield* effectClient.cancel(queued.id)
              expect(cancelling?.status).toBe('cancelling')
              return yield* Effect.fail(new Abort())
            }),
          )
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(await runStatus(queued.id)).toBe('queued')

      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql.withTransaction(effectClient.cancel(queued.id))
        }),
      )

      expect(await runStatus(queued.id)).toBe('cancelling')
    })

    it('rolls back an interrupted cancellation while the caller carries on and commits', async () => {
      const queued = await client.start(task, { value: 'cancel-interrupted' })
      const id = sampleId()
      // The task's run is cancelled first; settling its attempt then waits on
      // this lock.
      const unlock = await lockTable('workflow_attempts')
      try {
        await run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            return yield* sql.withTransaction(
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(
                  effectClient.cancel(queued.id),
                )

                yield* Effect.promise(() =>
                  expect
                    .poll(() => lockWaiters('workflow_attempts'))
                    .toBeGreaterThan(0),
                )

                yield* Fiber.interrupt(fiber)
                yield* insertSample(id)
              }),
            )
          }),
        )
      } finally {
        await unlock()
      }

      expect(await count('sample', 'id = $1', [id])).toBe(1)
      expect(await runStatus(queued.id)).toBe('queued')
    })

    it('starts on the workflow pool outside a transaction', async () => {
      const started = await run(
        effectClient.start(workflow, { value: 'outside' }),
      )

      expect(poolUses).toBeGreaterThan(0)
      expect(await count('workflow_runs', 'id = $1', [started.id])).toBe(1)
    })
  },
)
