import { PGlite, type Transaction } from '@electric-sql/pglite'
import * as Schema from 'effect/Schema'
import { afterEach, expect, test, vi } from 'vitest'

import type { ClaimedAttempt } from '../src/runtime/index.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow } from '../src/effect/index.ts'
import { defineSchedule } from '../src/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../src/runtime/worker.ts'

// PostgreSQL fences through its transaction and ignores the claim it is handed.
const unclaimed = {} as ClaimedAttempt

type Row = Record<string, unknown>

const createPgliteConnection = (db = new PGlite()) =>
  createPostgresWorkflowConnection(db)

// The shape of a single `pg.Client`: one session, no transaction API.
const createPlainClient = (db: PGlite) => ({
  query: <T extends Row = Row>(sql: string, params: readonly unknown[] = []) =>
    db.query<T>(sql, [...params]),
})

// Runs `afterQuery` on the transaction's own session right after each
// statement, which is how a test lands a write between two store statements.
const createInterceptedClient = (
  db: PGlite,
  afterQuery: (sql: string, tx: Transaction) => Promise<void>,
) => ({
  query: <T extends Row = Row>(sql: string, params: readonly unknown[] = []) =>
    db.query<T>(sql, [...params]),
  transaction: <T>(
    handler: (connection: {
      query<R extends Row = Row>(
        sql: string,
        params?: readonly unknown[],
      ): Promise<{ readonly rows: readonly R[] }>
    }) => Promise<T>,
  ) =>
    db.transaction((tx) =>
      handler({
        query: async <R extends Row = Row>(
          sql: string,
          params: readonly unknown[] = [],
        ) => {
          const result = await tx.query<R>(sql, [...params])
          await afterQuery(sql, tx)
          return result
        },
      }),
    ) as Promise<T>,
})

async function rows<T extends Row>(
  connection: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) {
  return (await connection.query<T>(sql, params)).rows
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('retention keeps an unreaped dead command so its run still settles', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({
    connection,
    maxDeliveries: 1,
  })
  const workflow = defineWorkflow({
    name: 'review-postgres-retention',
    input: Schema.Struct({ value: Schema.String }),
  }).build()
  const run = await createWorkflowRuntimeClient(runtime).start(workflow, {
    value: 'alpha',
  })

  const claimed = await runtime.runCoordinationExecutor.claim({
    workerId: 'review-postgres',
    workflowNames: [workflow.name],
    leaseMs: 30_000,
  })
  expect(claimed).not.toBeNull()
  await runtime.runCoordinationExecutor.release(claimed!, {
    error: new Error('poison'),
  })
  expect(await runtime.store.listUnreapedDeadCommands()).toHaveLength(1)

  // downtime longer than the retention window: the cutoff is past dead_at
  // before any reaper has seen the command
  const olderThan = Date.now() + 60_000
  await runtime.retentionPruner!.pruneTerminalRuns({ olderThan })
  expect(await runtime.store.listUnreapedDeadCommands()).toHaveLength(1)

  await expect(
    reapDeadWorkflowCommands({
      store: runtime.store,
      attemptExecutor: runtime.attemptExecutor,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
    }),
  ).resolves.toStrictEqual({ reaped: 1 })
  expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
    'failed',
  )

  // once the outcome is recorded the command is ordinary history
  await runtime.retentionPruner!.pruneTerminalRuns({ olderThan, statuses: [] })
  expect(await runtime.store.listDeadCommands()).toHaveLength(0)
})

test('a plain client keeps a top-level write out of another caller’s transaction', async () => {
  const connection = createPostgresWorkflowConnection(
    createPlainClient(new PGlite()),
  )
  await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')

  let markSuspended!: () => void
  const suspended = new Promise<void>((resolve) => {
    markSuspended = resolve
  })
  let resume!: () => void
  const resumed = new Promise<void>((resolve) => {
    resume = resolve
  })

  const transaction = connection.transaction(async (tx) => {
    await tx.query('INSERT INTO sample (id) VALUES (1)')
    markSuspended()
    await resumed
    throw new Error('rollback')
  })
  await suspended
  const write = connection.query('INSERT INTO sample (id) VALUES (2)')
  resume()

  await expect(transaction).rejects.toThrow('rollback')
  await write
  expect(await rows(connection, 'SELECT id FROM sample')).toEqual([{ id: 2 }])
})

test.each([
  ['a client transaction API', (db: PGlite) => db],
  ['a plain client', createPlainClient],
])(
  'a nested transaction is a rollback boundary on %s',
  async (_name, createClient) => {
    const connection = createPostgresWorkflowConnection(
      createClient(new PGlite()),
    )
    await connection.query('CREATE TABLE sample (id integer PRIMARY KEY)')

    await connection.transaction(async (tx) => {
      await tx.query('INSERT INTO sample (id) VALUES (1)')
      await expect(
        tx.transaction(async (nested) => {
          await nested.query('INSERT INTO sample (id) VALUES (2)')
          await nested.transaction(async (inner) => {
            await inner.query('INSERT INTO sample (id) VALUES (3)')
          })
          // a failed statement aborts the transaction up to the savepoint
          await nested.query('INSERT INTO sample (id) VALUES (1)')
        }),
      ).rejects.toThrow()
      await tx.transaction(async (nested) => {
        await nested.query('INSERT INTO sample (id) VALUES (4)')
      })
    })

    expect(await rows(connection, 'SELECT id FROM sample ORDER BY id')).toEqual(
      [{ id: 1 }, { id: 4 }],
    )
  },
)

async function createAttemptHarness(
  afterQuery: (sql: string, tx: Transaction) => Promise<void>,
) {
  const connection = createPostgresWorkflowConnection(
    createInterceptedClient(new PGlite(), afterQuery),
  )
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const run = await runtime.store.createRun({
    workflowName: 'review-postgres-fence',
    input: {},
  })
  await runtime.store.createNode({
    runId: run.id,
    name: 'step',
    kind: 'workflow',
  })
  await runtime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: 'step',
    children: [{ childKey: '$self', kind: 'workflow' }],
  })
  return { connection, runtime, run }
}

test('a stale completion fence inside atomic completion leaves the attempt untouched', async () => {
  let interleave = false
  const { connection, runtime, run } = await createAttemptHarness(
    async (sql, tx) => {
      if (!interleave || !sql.includes('UPDATE workflow_attempts')) return
      interleave = false
      // the child settles between the attempt update and the child update
      await tx.query(`UPDATE workflow_node_children SET status = 'failed'`)
    },
  )
  const { attempt } = await runtime.store.ensureChildAttempt({
    runId: run.id,
    nodeName: 'step',
    childKey: '$self',
    input: {},
  })

  interleave = true
  await expect(
    runtime.atomicCompletion!.run(
      ({ store }) =>
        store.completeCurrentAttempt({
          attemptId: attempt.id,
          leaseToken: attempt.leaseToken!,
          output: { ok: true },
        }),
      unclaimed,
      runtime,
    ),
  ).resolves.toBeUndefined()

  expect(
    await rows(connection, 'SELECT status, output FROM workflow_attempts'),
  ).toEqual([{ status: 'started', output: null }])
})

test('a failed child run link inside an outer transaction leaves no orphan run', async () => {
  let interleave = false
  const { connection, runtime, run } = await createAttemptHarness(
    async (sql, tx) => {
      if (!interleave || !sql.includes('INSERT INTO workflow_runs')) return
      interleave = false
      // the child settles between the run insert and the link update
      await tx.query(`UPDATE workflow_node_children SET status = 'failed'`)
    },
  )

  interleave = true
  await runtime.atomicCompletion!.run(
    async ({ store }) => {
      await expect(
        store.ensureChildRun({
          runId: run.id,
          nodeName: 'step',
          childKey: '$self',
          childKind: 'workflow',
          childName: 'review-postgres-fence-child',
          input: {},
          rootRunId: run.id,
        }),
      ).rejects.toThrow('cannot start child run')
    },
    unclaimed,
    runtime,
  )

  expect(await rows(connection, 'SELECT id FROM workflow_runs')).toEqual([
    { id: run.id },
  ])
})

test.each(['hello', '123'])(
  'a schedule keeps its string input %j as stored',
  async (input) => {
    const connection = createPgliteConnection()
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    const workflow = defineWorkflow({
      name: 'review-postgres-string-input',
      input: Schema.String,
    }).build()
    const schedule = defineSchedule({
      name: 'review-postgres-string-schedule',
      runnable: workflow,
      input,
      every: '10s',
      immediately: true,
    })
    await runtime.scheduler!.reconcile([schedule])

    expect(
      (await runtime.scheduler!.list()).map((entry) => entry.input),
    ).toEqual([input])
    const triggered = await runtime.scheduler!.trigger(schedule.name)
    expect(triggered.input).toBe(input)
    await expect(runtime.scheduler!.fireDue()).resolves.toStrictEqual({
      fired: 1,
    })
    await expect(
      runtime.scheduler!.setEnabled(schedule.name, false),
    ).resolves.toMatchObject({ input })

    expect(await rows(connection, 'SELECT input FROM workflow_runs')).toEqual([
      { input },
      { input },
    ])
  },
)

test('manual triggers from separate scheduler instances in one millisecond stay distinct', async () => {
  const db = new PGlite()
  const connection = createPgliteConnection(db)
  await installPostgresWorkflowSchemaForTesting(connection)
  const first = createPostgresWorkflowRuntime({ connection })
  const second = createPostgresWorkflowRuntime({
    connection: createPgliteConnection(db),
  })
  const workflow = defineWorkflow({
    name: 'review-postgres-manual-trigger',
    input: Schema.Struct({ value: Schema.String }),
  }).build()
  const schedule = defineSchedule({
    name: 'review-postgres-manual-schedule',
    runnable: workflow,
    input: { value: 'alpha' },
    every: '10s',
    immediately: true,
  })
  const triggeredAt = Date.UTC(2026, 0, 1)
  vi.spyOn(Date, 'now').mockReturnValue(triggeredAt)
  await first.scheduler!.reconcile([schedule])

  const left = await first.scheduler!.trigger(schedule.name)
  const right = await second.scheduler!.trigger(schedule.name)
  expect(right.id).not.toBe(left.id)
  expect((await first.scheduler!.list())[0]?.lastSlotAt).toBe(triggeredAt)

  // a recurring fire keeps its slot identity, so instances still agree on it
  await expect(second.scheduler!.fireDue()).resolves.toStrictEqual({ fired: 1 })
  const fired = await rows<{ idempotency_key: unknown }>(
    connection,
    'SELECT idempotency_key FROM workflow_runs WHERE id <> ALL($1::uuid[])',
    [[left.id, right.id]],
  )
  expect(fired).toEqual([
    { idempotency_key: ['$schedule', schedule.name, triggeredAt] },
  ])
  expect((await first.scheduler!.list())[0]?.lastSlotAt).toBe(triggeredAt)
})

test('attempt dispatch can look up an existing command by an index', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)

  expect(
    await rows(
      connection,
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'workflow_commands_attempt_idx'`,
    ),
  ).toEqual([
    {
      indexdef: expect.stringMatching(
        /ON public\.workflow_commands USING btree \(attempt_id\) WHERE \(attempt_id IS NOT NULL\)/,
      ),
    },
  ])
})
