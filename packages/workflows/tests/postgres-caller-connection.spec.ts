import { PGlite } from '@electric-sql/pglite'
import * as Schema from 'effect/Schema'
import { expect, test } from 'vitest'

import { createInMemoryWorkflowRuntime } from '../src/adapters/in-memory.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineTask, defineWorkflow } from '../src/effect/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'

const workflow = defineWorkflow({
  name: 'caller-connection-workflow',
  input: Schema.Struct({ value: Schema.String }),
}).build()

const task = defineTask({
  name: 'caller-connection-task',
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({}),
})

class Abort extends Error {}

async function createHarness() {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  const client = createWorkflowRuntimeClient({
    ...createPostgresWorkflowRuntime({ connection }),
    definitions: [workflow, task],
  })
  return { connection, client }
}

test('cancel with a connection commits or rolls back with the caller', async () => {
  const { connection, client } = await createHarness()
  const queued = await client.start(task, { value: 'cancel' })

  await expect(
    connection.transaction(async (tx) => {
      await client.cancel(queued.id, { connection: tx })
      throw new Abort()
    }),
  ).rejects.toBeInstanceOf(Abort)
  expect((await client.get(queued.id))?.run.status).toBe('queued')

  await connection.transaction((tx) =>
    client.cancel(queued.id, { connection: tx }),
  )
  expect((await client.get(queued.id))?.run.status).toBe('cancelled')
})

test('restart with a connection reads and starts inside the caller transaction', async () => {
  const { connection, client } = await createHarness()
  const original = await client.start(task, { value: 'restart' })
  await client.cancel(original.id)

  await expect(
    connection.transaction(async (tx) => {
      await client.restart(original.id, { connection: tx })
      throw new Abort()
    }),
  ).rejects.toBeInstanceOf(Abort)
  expect((await client.list()).runs).toHaveLength(1)

  const restarted = await connection.transaction((tx) =>
    client.restart(original.id, { connection: tx }),
  )
  expect(restarted.id).not.toBe(original.id)
  expect((await client.list()).runs).toHaveLength(2)
})

test('cancel rejects a connection the adapter cannot join', async () => {
  const { callerConnection: _, ...runtime } = createInMemoryWorkflowRuntime()
  const client = createWorkflowRuntimeClient<object>(runtime as never)
  const queued = await client.start(workflow, { value: 'unsupported' })

  await expect(client.cancel(queued.id, { connection: {} })).rejects.toThrow(
    'does not support caller-provided connections',
  )
  expect((await client.get(queued.id))?.run.status).toBe('queued')
})

test('the in-memory runtime ignores a caller connection on cancel', async () => {
  const client = createWorkflowRuntimeClient<object>(
    createInMemoryWorkflowRuntime() as never,
  )
  const queued = await client.start(task, { value: 'in-memory' })

  const cancelled = await client.cancel(queued.id, { connection: {} })
  expect(cancelled?.status).toBe('cancelled')
})
