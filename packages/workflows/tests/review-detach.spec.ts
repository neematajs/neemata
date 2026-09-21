import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { CancellationPolicy } from '../src/index.ts'
import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../src/runtime/worker.ts'

const text = z.string()

const child = defineWorkflow({
  name: 'review.detach.child',
  input: text,
  output: text,
})
  .activity('work', { input: text, output: text })
  .build()
const childImplementation = implementWorkflow(child, { pool: 'test' })
  .work(async (input) => `${input}!`)
  .finish(({ work }) => work)

// Each shape creates its child workflow run through a different dispatcher.
const shapes = {
  node: (cancellation?: CancellationPolicy) => {
    const parent = defineWorkflow({
      name: 'review.detach.node',
      input: text,
      output: text,
    })
      .workflow('sub', child, { cancellation })
      .build()
    const implementation = implementWorkflow(parent, { pool: 'test' })
      .sub(child)
      .finish(() => 'done')
    return { parent, implementation }
  },
  'branch case': (cancellation?: CancellationPolicy) => {
    const parent = defineWorkflow({
      name: 'review.detach.branch',
      input: text,
      output: text,
    })
      .branch('sub', {
        cases: (h) => ({ only: h.workflow(child, { cancellation }) }),
      })
      .build()
    const implementation = implementWorkflow(parent, { pool: 'test' })
      .sub({
        select: () => 'only' as const,
        cases: ({ workflow }) => ({ only: workflow(child) }),
      })
      .finish(() => 'done')
    return { parent, implementation }
  },
  'parallel member': (cancellation?: CancellationPolicy) => {
    const parent = defineWorkflow({
      name: 'review.detach.parallel',
      input: text,
      output: text,
    })
      .parallel('sub', (h) => ({ only: h.workflow(child, { cancellation }) }))
      .build()
    const implementation = implementWorkflow(parent, { pool: 'test' })
      .sub(({ workflow }) => ({ only: workflow(child) }))
      .finish(() => 'done')
    return { parent, implementation }
  },
  'map item': (cancellation?: CancellationPolicy) => {
    const parent = defineWorkflow({
      name: 'review.detach.map',
      input: text,
      output: text,
    })
      .mapWorkflow('sub', child, { item: text, cancellation })
      .build()
    const implementation = implementWorkflow(parent, { pool: 'test' })
      .sub(child, {
        items: (_outputs, input) => [input],
        input: (_outputs, item) => item,
      })
      .finish(() => 'done')
    return { parent, implementation }
  },
}

const shapeNames = Object.keys(shapes) as (keyof typeof shapes)[]

async function startParent(
  shape: keyof typeof shapes,
  cancellation?: CancellationPolicy,
) {
  const { parent, implementation } = shapes[shape](cancellation)
  const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
  const client = createWorkflowRuntimeClient(runtime)
  const workers = {
    ...runtime,
    workflows: [implementation, childImplementation],
    tasks: [],
    workerId: 'review',
  }
  const run = await client.start(parent, 'hi')
  // Parks the parent on its child; the child stays live on its unclaimed activity.
  await runWorkflowWorker(workers)
  const edge = (await client.get(run.id))!.children[0]!
  expect((await client.get(edge.childRunId!))!.run.status).toBe('running')

  const drain = async () => {
    for (let round = 0; round < 4; round++) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }
  }
  return {
    parent,
    runtime,
    client,
    run,
    childRunId: edge.childRunId!,
    coordinate: () => runWorkflowWorker(workers),
    drain,
  }
}

describe('child workflow cancellation policy', () => {
  it.each(shapeNames)(
    'leaves a detached %s running when its parent is cancelled',
    async (shape) => {
      const { runtime, client, run, childRunId, coordinate, drain } =
        await startParent(shape, 'detach')
      expect((await client.get(run.id))!.children[0]!.cancellation).toBe(
        'detach',
      )

      await client.cancel(run.id)
      await coordinate()
      expect((await client.get(run.id))!.run.status).toBe('cancelled')
      expect((await client.get(childRunId))!.run.status).toBe('running')

      // The child finishes and wakes a parent that is already terminal.
      await drain()
      const finished = (await client.get(childRunId))!
      expect(finished.run.status).toBe('completed')
      expect(finished.run.output).toBe('hi!')
      expect((await client.get(run.id))!.run.status).toBe('cancelled')
      expect(runtime.inspect().continueRunCommands).toHaveLength(0)
      expect(await runtime.store.listDeadCommands()).toHaveLength(0)
    },
  )

  it.each(shapeNames)(
    'still cancels a propagating %s with its parent',
    async (shape) => {
      for (const policy of [undefined, 'propagate'] as const) {
        const { runtime, client, run, childRunId, drain } = await startParent(
          shape,
          policy,
        )

        await client.cancel(run.id)
        await drain()
        expect((await client.get(run.id))!.run.status).toBe('cancelled')
        expect((await client.get(childRunId))!.run.status).toBe('cancelled')
        expect(runtime.inspect().activityCommands).toHaveLength(0)
      }
    },
  )

  async function reapParent(cancellation?: CancellationPolicy) {
    const started = await startParent('node', cancellation)
    const { parent, runtime, run } = started
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: parent.name,
    })
    const continuation = await runtime.runCoordinationExecutor.claim({
      workflowNames: [parent.name],
      workerId: 'review',
      leaseMs: 30_000,
    })
    await runtime.runCoordinationExecutor.release(continuation!, {
      error: new Error('dead'),
    })
    expect(await reapDeadWorkflowCommands(runtime)).toEqual({ reaped: 1 })
    expect((await started.client.get(run.id))!.run.status).toBe('failed')
    return started
  }

  it('leaves a detached child alone when the reaper fails its parent', async () => {
    const { client, childRunId, drain } = await reapParent('detach')
    expect((await client.get(childRunId))!.run.status).toBe('running')

    await drain()
    expect((await client.get(childRunId))!.run.status).toBe('completed')
  })

  it('cancels a propagating child when the reaper fails its parent', async () => {
    const { client, childRunId } = await reapParent()
    expect((await client.get(childRunId))!.run.status).toBe('cancelled')
  })
})
