import { PGlite } from '@electric-sql/pglite'
import { describe, expect, test } from 'vitest'
import * as z from 'zod'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

async function createRuntime(maxDeliveries?: number) {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection, maxDeliveries })
  return { connection, runtime }
}

describe('child workflow cancellation policy', () => {
  const text = z.string()
  const child = defineWorkflow({
    name: 'postgres.detach.child',
    input: text,
    output: text,
  })
    .activity('work', { input: text, output: text })
    .build()
  const childImplementation = implementWorkflow(child, { pool: 'test' })
    .work(async (input) => `${input}!`)
    .finish(({ work }) => work)
  const parent = defineWorkflow({
    name: 'postgres.detach.parent',
    input: text,
    output: text,
  })
    .workflow('sub', child, { cancellation: 'detach' })
    .build()
  const parentImplementation = implementWorkflow(parent, { pool: 'test' })
    .sub(child)
    .finish(() => 'done')

  test('run detail reports a stored detach policy', async () => {
    const { runtime } = await createRuntime()
    const { store } = runtime
    const run = await store.createRun({
      workflowName: 'detach-detail',
      input: {},
    })
    const ref = { runId: run.id, nodeName: 'sub', childKey: '$self' }
    await store.createNode({
      runId: run.id,
      name: ref.nodeName,
      kind: 'workflow',
    })
    await store.ensureNodeChildren({
      ...ref,
      children: [{ childKey: ref.childKey, kind: 'workflow' }],
    })
    await store.ensureChildRun({
      ...ref,
      childKind: 'workflow',
      childName: 'detach-detail-child',
      input: {},
      rootRunId: run.id,
      cancellation: 'detach',
    })

    const client = createWorkflowRuntimeClient(runtime)
    expect((await client.get(run.id))!.children[0]!.cancellation).toBe('detach')
    expect((await client.getDetail(run.id))!.children[0]!.cancellation).toBe(
      'detach',
    )
  })

  test('a detached child outlives its cancelled parent and completes', async () => {
    const { connection, runtime } = await createRuntime(1)
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [parentImplementation, childImplementation],
      tasks: [],
      workerId: 'detach-worker',
    }
    const run = await client.start(parent, 'hi')
    // Parks the parent on its child; the child stays live on its unclaimed activity.
    await runWorkflowWorker(workers)
    const edge = (await client.get(run.id))!.children[0]!
    expect(edge.cancellation).toBe('detach')
    expect((await client.get(edge.childRunId!))!.run.status).toBe('running')

    await client.cancel(run.id)
    await runWorkflowWorker(workers)
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect((await client.get(edge.childRunId!))!.run.status).toBe('running')

    // The child finishes and wakes a parent that is already terminal.
    for (let round = 0; round < 4; round++) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }
    const finished = (await client.get(edge.childRunId!))!
    expect(finished.run.status).toBe('completed')
    expect(finished.run.output).toBe('hi!')
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect(await runtime.store.listDeadCommands()).toHaveLength(0)
    const pending = await connection.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM workflow_commands',
    )
    expect(pending.rows[0]!.count).toBe(0)
  })
})
