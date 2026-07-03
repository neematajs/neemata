import { PGlite } from '@electric-sql/pglite'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { expect, test } from 'vitest'

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
} from '../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runActivityWorker,
  runTaskWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

const createPgliteConnection = () =>
  createPostgresWorkflowConnection(new PGlite())

function createTestContainer() {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  return new Container({ logger })
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
    input: t.object({ value: t.string() }),
    output: t.object({ value: t.string() }),
  }).build()
  const workflowImpl = implementWorkflow(workflow).finish(
    (_ctx, _outputs, input) => ({ value: input.value }),
  )
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })

  await expect(
    runWorkflowWorker({
      ...failingRuntime,
      workflows: [workflowImpl],
      container: createTestContainer(),
      workerId: 'workflow-worker',
    }),
  ).rejects.toThrow('forced command ack failure')

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
    input: t.object({ value: t.string() }),
    output: t.object({ value: t.string() }),
  }).build()
  const workflowImpl = implementWorkflow(workflow).finish(
    (_ctx, _outputs, input) => ({ value: input.value }),
  )
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })

  await expect(
    runWorkflowWorker({
      ...staleRuntime,
      workflows: [workflowImpl],
      container: createTestContainer(),
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
    input: t.object({ value: t.string() }),
    output: t.object({ value: t.string() }),
  })
    .activity('content', {
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    })
    .build()
  const workflowImpl = implementWorkflow(workflow)
    .content(async (_ctx, input) => ({ value: input.value }))
    .finish((_ctx, { content }) => content)
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })

  await expect(
    runWorkflowWorker({
      ...failingRuntime,
      workflows: [workflowImpl],
      container: createTestContainer(),
      workerId: 'workflow-worker',
    }),
  ).rejects.toThrow('forced command ack failure')

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
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })
  const taskImpl = implementTask(task, {
    handler: async (_ctx, input) => ({ id: input.text }),
  })
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(task, { text: 'alpha' })

  await expect(
    runTaskWorker({
      ...failingRuntime,
      tasks: [taskImpl],
      container: createTestContainer(),
      workerId: 'task-worker',
    }),
  ).rejects.toThrow('forced command ack failure')

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('queued')
  expect(snapshot?.nodes[0]?.status).toBe('waiting')
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
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })
  const taskImpl = implementTask(task, {
    handler: async () => {
      throw new Error('task failed')
    },
  })
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(task, { text: 'alpha' })

  await expect(
    runTaskWorker({
      ...failingRuntime,
      tasks: [taskImpl],
      container: createTestContainer(),
      workerId: 'task-worker',
    }),
  ).rejects.toThrow('forced command ack failure')

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('queued')
  expect(snapshot?.run.error).toBeUndefined()
  expect(snapshot?.nodes[0]?.status).toBe('waiting')
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
    input: t.object({ value: t.string() }),
    output: t.object({ value: t.string() }),
  })
    .activity('content', {
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    })
    .build()
  const workflowImpl = implementWorkflow(workflow)
    .content(async (_ctx, input) => ({ value: input.value }))
    .finish((_ctx, { content }) => content)
  const container = createTestContainer()
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })
  await runWorkflowWorker({
    ...runtime,
    workflows: [workflowImpl],
    container,
    workerId: 'workflow-worker',
  })
  const beforeActivity = await runtime.store.loadRunSnapshot(run.id)
  const beforeNodeStatus = beforeActivity?.nodes[0]?.status
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(1)

  await expect(
    runActivityWorker({
      ...failingRuntime,
      workflows: [workflowImpl],
      container,
      workerId: 'activity-worker',
    }),
  ).rejects.toThrow('forced command ack failure')

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('queued')
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
    input: t.object({ value: t.string() }),
    output: t.object({ value: t.string() }),
  })
    .activity('content', {
      input: t.object({ value: t.string() }),
      output: t.object({ value: t.string() }),
    })
    .build()
  const workflowImpl = implementWorkflow(workflow)
    .content(async (_ctx, input) => ({ value: input.value }))
    .finish((_ctx, { content }) => content)
  const container = createTestContainer()
  const client = createWorkflowRuntimeClient(runtime)

  const run = await client.start(workflow, { value: 'alpha' })
  await runWorkflowWorker({
    ...runtime,
    workflows: [workflowImpl],
    container,
    workerId: 'workflow-worker',
  })
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(1)

  await expect(
    runActivityWorker({
      ...staleRuntime,
      workflows: [workflowImpl],
      container,
      workerId: 'activity-worker',
    }),
  ).resolves.toStrictEqual({ processed: 0 })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)
  expect(snapshot?.run.status).toBe('queued')
  expect(snapshot?.nodes[0]?.output).toBeUndefined()
  expect(snapshot?.attempts[0]?.status).toBe('started')
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'continue'"),
  ).toBe(0)
  expect(
    await countRows(connection, 'workflow_commands', "kind = 'activity'"),
  ).toBe(1)
})
