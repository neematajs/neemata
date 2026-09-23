import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runWorkflowWorker,
} from '../src/runtime/index.ts'
import { timeoutExpiredWorkflowRuns } from '../src/runtime/worker.ts'

const text = z.string()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('run timeout sweep', () => {
  it('still wakes the parent when the wake after failing the child is lost', async () => {
    const child = defineWorkflow({
      name: 'timeouts.sweep.child',
      input: text,
      output: text,
      timeout: '20ms',
    })
      .activity('step', { input: text, output: text })
      .build()
    const childImplementation = implementWorkflow(child, { pool: 'test' })
      .step(async (input) => input)
      .finish(({ step }) => step)
    const parent = defineWorkflow({
      name: 'timeouts.sweep.parent',
      input: text,
      output: text,
    })
      .workflow('sub', child)
      .build()
    const parentImplementation = implementWorkflow(parent, { pool: 'test' })
      .sub(child)
      .finish(({ sub }) => sub)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [parentImplementation, childImplementation],
      workerId: 'timeouts',
      reaping: false,
      runTimeouts: false,
    } as const
    const run = await client.start(parent, 'hi')
    // No execution worker ever runs, so the child sits on its activity.
    await runWorkflowWorker(workers)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)

    await wait(30)
    await expect(
      timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows: [parentImplementation, childImplementation],
        runCoordinationExecutor: {
          ...runtime.runCoordinationExecutor,
          enqueue: async (command) => {
            if (command.runId === run.id) {
              throw new Error('injected wake failure')
            }
            await runtime.runCoordinationExecutor.enqueue(command)
          },
        },
      }),
    ).rejects.toThrow('injected wake failure')

    const childRun = runtime
      .inspect()
      .runs.find(({ parentRunId }) => parentRunId === run.id)!
    expect(childRun.status).toBe('failed')
    expect((await client.get(run.id))!.run.status).toBe('waiting')
    // The terminal child is out of every later sweep's reach.
    expect(
      await timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows: [parentImplementation, childImplementation],
      }),
    ).toStrictEqual({ timedOut: 0 })

    await runWorkflowWorker(workers)
    await runWorkflowWorker(workers)
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('failed')
    expect(snapshot.run.error?.message).toContain('timed out after [20ms]')
  })
})

describe('interrupted run timeout', () => {
  function setup() {
    const leaf = defineWorkflow({
      name: 'timeouts.interrupted.leaf',
      input: text,
      output: text,
    })
      .activity('step', { input: text, output: text })
      .build()
    const leafImplementation = implementWorkflow(leaf, { pool: 'test' })
      .step(async (input) => input)
      .finish(({ step }) => step)
    const middle = defineWorkflow({
      name: 'timeouts.interrupted.middle',
      input: text,
      output: text,
      timeout: '20ms',
    })
      .workflow('sub', leaf)
      .build()
    const middleImplementation = implementWorkflow(middle, { pool: 'test' })
      .sub(leaf)
      .finish(({ sub }) => sub)
    const parent = defineWorkflow({
      name: 'timeouts.interrupted.parent',
      input: text,
      output: text,
    })
      .workflow('sub', middle)
      .build()
    const parentImplementation = implementWorkflow(parent, { pool: 'test' })
      .sub(middle)
      .finish(({ sub }) => sub)

    const runtime = createInMemoryWorkflowRuntime()
    const workflows = [
      parentImplementation,
      middleImplementation,
      leafImplementation,
    ]
    const workers = {
      ...runtime,
      workflows,
      workerId: 'timeouts',
      reaping: false,
      runTimeouts: false,
    } as const
    const runOf = (name: string) =>
      runtime.inspect().runs.find((run) => run.workflowName === name)!
    return { runtime, workflows, workers, parent, middle, leaf, runOf }
  }

  it('leaves the run for the next sweep when failing it is rejected', async () => {
    const { runtime, workflows, workers, parent, middle, leaf, runOf } = setup()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(parent, 'hi')
    // No execution worker ever runs, so the leaf sits on its activity.
    await runWorkflowWorker(workers)
    await wait(30)

    await expect(
      timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows,
        store: {
          ...runtime.store,
          failRun: async () => {
            throw new Error('injected failRun failure')
          },
        },
      }),
    ).rejects.toThrow('injected failRun failure')

    // The queued continuation must find nothing to cancel.
    await runWorkflowWorker(workers)
    expect(runOf(middle.name).status).toBe('waiting')
    expect(runOf(leaf.name).status).toBe('running')
    expect((await client.get(run.id))!.run.status).toBe('waiting')

    expect(
      await timeoutExpiredWorkflowRuns({ ...runtime, workflows }),
    ).toStrictEqual({ timedOut: 1 })
    await runWorkflowWorker(workers)

    const timedOut = runOf(middle.name)
    expect(timedOut.status).toBe('failed')
    expect(timedOut.error?.message).toContain('timed out after [20ms]')
    expect(runOf(leaf.name).status).toBe('cancelled')
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('failed')
    expect(snapshot.run.error?.message).toContain('timed out after [20ms]')
  })

  it('finishes the cancellation and the parent wake after a crash right after failing the run', async () => {
    const { runtime, workflows, workers, parent, middle, leaf, runOf } = setup()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(parent, 'hi')
    await runWorkflowWorker(workers)
    await wait(30)

    await expect(
      timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows,
        store: {
          ...runtime.store,
          failRun: async (params) => {
            await runtime.store.failRun(params)
            throw new Error('injected crash after failRun')
          },
        },
      }),
    ).rejects.toThrow('injected crash after failRun')

    expect(runOf(middle.name).status).toBe('failed')
    expect(runOf(middle.name).error?.message).toContain(
      'timed out after [20ms]',
    )
    expect(runOf(leaf.name).status).toBe('running')
    // The terminal run is out of every later sweep's reach.
    expect(
      await timeoutExpiredWorkflowRuns({ ...runtime, workflows }),
    ).toStrictEqual({ timedOut: 0 })

    await runWorkflowWorker(workers)
    await runWorkflowWorker(workers)

    expect(runOf(middle.name).status).toBe('failed')
    expect(runOf(leaf.name).status).toBe('cancelled')
    expect(
      runtime
        .inspect()
        .nodes.filter(({ runId }) => runId === runOf(middle.name).id)
        .map(({ status }) => status),
    ).toStrictEqual(['cancelled'])
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('failed')
    expect(snapshot.run.error?.message).toContain('timed out after [20ms]')
  })
})
