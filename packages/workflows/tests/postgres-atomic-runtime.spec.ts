import { PGlite, type Transaction } from '@electric-sql/pglite'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import { describe, expect, test } from 'vitest'

import type { ClaimedAttempt } from '../src/runtime/index.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/effect/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'
import { fromPromise } from './support/effect.ts'

type Row = Record<string, unknown>

const createPgliteConnection = () =>
  createPostgresWorkflowConnection(new PGlite())

// PostgreSQL fences through its transaction and ignores the claim it is handed.
const unclaimed = {} as ClaimedAttempt

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

function createTestContext() {
  return Context.empty()
}

function failNextCommandAck(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let failed = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (!failed && /DELETE\s+FROM\s+workflow_commands/i.test(sql)) {
        failed = true
        throw new Error('forced command ack failure')
      }

      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function staleNextCommandAckLease(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let stale = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query(sql, params = []) {
      if (!stale && /DELETE\s+FROM\s+workflow_commands/i.test(sql)) {
        stale = true
        await target.query(
          `
            UPDATE workflow_commands
            SET lease_token = 'stale-command-lease'
            WHERE id = $1
          `,
          [params[0]],
        )
      }

      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

async function countRows(
  connection: WorkflowPostgresConnection,
  table: string,
  where = 'true',
) {
  const result = await connection.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE ${where}`,
  )
  return result.rows[0]?.count ?? 0
}

test('rolls back empty workflow completion when command ack fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const failingRuntime = createPostgresWorkflowRuntime({
    connection: failNextCommandAck(connection),
  })
  const workflow = defineWorkflow({
    name: 'atomic-continuation-empty-workflow',
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
  }).build()
  const workflowImpl = implementWorkflow(workflow, { pool: 'test' }).finish(
    (_outputs, input) => fromPromise(() => ({ value: input.value })),
  )
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })

  const errors: unknown[] = []
  await expect(
    runWorkflowWorker({
      ...failingRuntime,
      workflows: [workflowImpl],
      context: createTestContext(),
      workerId: 'workflow-worker',
      onError: (error) => errors.push(error),
    }),
  ).resolves.toStrictEqual({ processed: 0 })
  expect(errors).toMatchObject([{ message: 'forced command ack failure' }])

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('queued')
  expect(snapshot?.run.output).toBeUndefined()
  expect(await countRows(connection, 'workflow_commands')).toBe(1)
})

test('rolls back workflow continuation when command ack lease is stale', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const staleRuntime = createPostgresWorkflowRuntime({
    connection: staleNextCommandAckLease(connection),
  })
  const workflow = defineWorkflow({
    name: 'stale-continuation-empty-workflow',
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
  }).build()
  const workflowImpl = implementWorkflow(workflow, { pool: 'test' }).finish(
    (_outputs, input) => fromPromise(() => ({ value: input.value })),
  )
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })

  await expect(
    runWorkflowWorker({
      ...staleRuntime,
      workflows: [workflowImpl],
      context: createTestContext(),
      workerId: 'workflow-worker',
    }),
  ).resolves.toStrictEqual({ processed: 0 })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('queued')
  expect(snapshot?.run.output).toBeUndefined()
  expect(await countRows(connection, 'workflow_commands')).toBe(1)
})

test('rolls back activity dispatch when command ack fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const failingRuntime = createPostgresWorkflowRuntime({
    connection: failNextCommandAck(connection),
  })
  const workflow = defineWorkflow({
    name: 'atomic-continuation-activity-workflow',
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
  })
    .activity('content', {
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({ value: Schema.String }),
    })
    .build()
  const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
    .content((input) => fromPromise(async () => ({ value: input.value })))
    .finish(({ content }) => fromPromise(() => content))
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })

  const errors: unknown[] = []
  await expect(
    runWorkflowWorker({
      ...failingRuntime,
      workflows: [workflowImpl],
      context: createTestContext(),
      workerId: 'workflow-worker',
      onError: (error) => errors.push(error),
    }),
  ).resolves.toStrictEqual({ processed: 0 })
  expect(errors).toMatchObject([{ message: 'forced command ack failure' }])

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('queued')
  expect(snapshot?.nodes).toStrictEqual([])
  expect(snapshot?.attempts).toStrictEqual([])
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'continue'"),
  ).toBe(1)
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(0)
})

test('rolls back standalone task completion when command ack fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const failingRuntime = createPostgresWorkflowRuntime({
    connection: failNextCommandAck(connection),
  })
  const task = defineTask({
    name: 'atomic-completion-task',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  })
  const taskImpl = implementTask(task, {
    pool: 'test',
    handler: (input) => fromPromise(async () => ({ id: input.text })),
  })
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(task, { text: 'alpha' })

  const errors: unknown[] = []
  await expect(
    runExecutionWorker({
      workflows: [],
      ...failingRuntime,
      tasks: [taskImpl],
      context: createTestContext(),
      workerId: 'task-worker',
      onError: (error) => errors.push(error),
    }),
  ).resolves.toStrictEqual({ processed: 0 })
  expect(errors).toMatchObject([{ message: 'forced command ack failure' }])

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('running')
  expect(snapshot?.nodes[0]?.status).toBe('running')
  expect(snapshot?.attempts[0]?.status).toBe('started')
  expect(await countRows(connection, 'workflow_commands')).toBe(1)
})

test('rolls back standalone task failure when command ack fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const failingRuntime = createPostgresWorkflowRuntime({
    connection: failNextCommandAck(connection),
  })
  const task = defineTask({
    name: 'atomic-failure-task',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  })
  const taskImpl = implementTask(task, {
    pool: 'test',
    handler: () =>
      fromPromise(async () => {
        throw new Error('task failed')
      }),
  })
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(task, { text: 'alpha' })

  const errors: unknown[] = []
  await expect(
    runExecutionWorker({
      workflows: [],
      ...failingRuntime,
      tasks: [taskImpl],
      context: createTestContext(),
      workerId: 'task-worker',
      onError: (error) => errors.push(error),
    }),
  ).resolves.toStrictEqual({ processed: 0 })
  expect(errors).toMatchObject([{ message: 'forced command ack failure' }])

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('running')
  expect(snapshot?.run.error).toBeUndefined()
  expect(snapshot?.nodes[0]?.status).toBe('running')
  expect(snapshot?.nodes[0]?.error).toBeUndefined()
  expect(snapshot?.attempts[0]?.status).toBe('started')
  expect(snapshot?.attempts[0]?.error).toBeUndefined()
  expect(await countRows(connection, 'workflow_commands')).toBe(1)
})

test('rolls back activity completion when command ack fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const failingRuntime = createPostgresWorkflowRuntime({
    connection: failNextCommandAck(connection),
  })
  const workflow = defineWorkflow({
    name: 'atomic-completion-workflow',
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
  })
    .activity('content', {
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({ value: Schema.String }),
    })
    .build()
  const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
    .content((input) => fromPromise(async () => ({ value: input.value })))
    .finish(({ content }) => fromPromise(() => content))
  const context = createTestContext()
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })
  await runWorkflowWorker({
    ...runtime,
    workflows: [workflowImpl],
    context,
    workerId: 'workflow-worker',
  })
  const beforeActivity = await runtime.store.loadRunSnapshot(run.id)
  const beforeNodeStatus = beforeActivity?.nodes[0]?.status
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(1)

  const errors: unknown[] = []
  await expect(
    runExecutionWorker({
      tasks: [],
      ...failingRuntime,
      workflows: [workflowImpl],
      context,
      workerId: 'activity-worker',
      onError: (error) => errors.push(error),
    }),
  ).resolves.toStrictEqual({ processed: 0 })
  expect(errors).toMatchObject([{ message: 'forced command ack failure' }])

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('running')
  expect(snapshot?.nodes[0]?.status).toBe(beforeNodeStatus)
  expect(snapshot?.nodes[0]?.output).toBeUndefined()
  expect(snapshot?.attempts[0]?.status).toBe('started')
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'continue'"),
  ).toBe(0)
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(1)
})

test('rolls back activity completion when command ack lease is stale', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const staleRuntime = createPostgresWorkflowRuntime({
    connection: staleNextCommandAckLease(connection),
  })
  const workflow = defineWorkflow({
    name: 'stale-completion-workflow',
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
  })
    .activity('content', {
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.Struct({ value: Schema.String }),
    })
    .build()
  const workflowImpl = implementWorkflow(workflow, { pool: 'test' })
    .content((input) => fromPromise(async () => ({ value: input.value })))
    .finish(({ content }) => fromPromise(() => content))
  const context = createTestContext()
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })
  await runWorkflowWorker({
    ...runtime,
    workflows: [workflowImpl],
    context,
    workerId: 'workflow-worker',
  })
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(1)

  await expect(
    runExecutionWorker({
      tasks: [],
      ...staleRuntime,
      workflows: [workflowImpl],
      context,
      workerId: 'activity-worker',
    }),
  ).resolves.toStrictEqual({ processed: 0 })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('running')
  expect(snapshot?.nodes[0]?.output).toBeUndefined()
  expect(snapshot?.attempts[0]?.status).toBe('started')
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'continue'"),
  ).toBe(0)
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(1)
})

describe('fences inside atomic completion', () => {
  async function createAttemptHarness(
    afterQuery: (sql: string, tx: Transaction) => Promise<void>,
  ) {
    const connection = createPostgresWorkflowConnection(
      createInterceptedClient(new PGlite(), afterQuery),
    )
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    const run = await runtime.store.createRun({
      workflowName: 'atomic-completion-fence',
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
            childName: 'atomic-completion-fence-child',
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
})
