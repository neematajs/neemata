import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  type WorkflowStore,
} from '../src/runtime/index.ts'
import { timeoutExpiredWorkflowRuns } from '../src/runtime/worker.ts'

const text = z.string()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Suspends the first matching call so the test can interleave other actors. */
function gate() {
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let used = false
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    async pass() {
      if (used) return
      used = true
      reached.resolve()
      await released.promise
    },
  }
}

describe('cancelling a parent while its child workflow is mid-pass', () => {
  function setup(options: { readonly parentTimeout?: '20ms' } = {}) {
    let leafRan = 0
    const leaf = defineWorkflow({
      name: 'review5.cancel.leaf',
      input: text,
      output: text,
    })
      .activity('step', { input: text, output: text })
      .build()
    const leafImplementation = implementWorkflow(leaf, { pool: 'test' })
      .step(async (input) => {
        leafRan += 1
        return input
      })
      .finish(({ step }) => step)
    const middle = defineWorkflow({
      name: 'review5.cancel.middle',
      input: text,
      output: text,
    })
      .workflow('sub', leaf)
      .build()
    const middleImplementation = implementWorkflow(middle, { pool: 'test' })
      .sub(leaf)
      .finish(({ sub }) => sub)
    const parent = defineWorkflow({
      name: 'review5.cancel.parent',
      input: text,
      output: text,
      ...(options.parentTimeout ? { timeout: options.parentTimeout } : {}),
    })
      .workflow('sub', middle)
      .build()
    const parentImplementation = implementWorkflow(parent, { pool: 'test' })
      .sub(middle)
      .finish(({ sub }) => sub)

    const runtime = createInMemoryWorkflowRuntime()
    const base = {
      ...runtime,
      workerId: 'review5',
      reaping: false,
      runTimeouts: false,
    } as const
    const all = [parentImplementation, middleImplementation, leafImplementation]
    const runOf = (name: string) =>
      runtime.inspect().runs.find((run) => run.workflowName === name)
    const drain = async () => {
      for (let pass = 0; pass < 3; pass += 1) {
        await runWorkflowWorker({ ...base, workflows: all })
        await runExecutionWorker({ ...base, workflows: all, tasks: [] })
      }
    }
    return {
      runtime,
      base,
      all,
      parent,
      middle,
      leaf,
      parentImplementation,
      middleImplementation,
      runOf,
      drain,
      leafRan: () => leafRan,
    }
  }

  it('leaves a coordinated child to its own continuation, which cancels what the pass started', async () => {
    const s = setup()
    const client = createWorkflowRuntimeClient(s.runtime)
    const run = await client.start(s.parent, 'hi')
    await runWorkflowWorker({ ...s.base, workflows: [s.parentImplementation] })

    // The middle pass is suspended on the write that creates the leaf, past
    // every cancellation check it makes itself.
    const paused = gate()
    const store: WorkflowStore = {
      ...s.runtime.store,
      ensureChildRun: async (params) => {
        await paused.pass()
        return s.runtime.store.ensureChildRun(params)
      },
    }
    const middlePass = runWorkflowWorker({
      ...s.base,
      store,
      workflows: [s.middleImplementation],
    })
    await paused.reached

    await client.cancel(run.id)
    await runWorkflowWorker({ ...s.base, workflows: [s.parentImplementation] })
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    // Terminalizing the child here would hide the leaf it is about to start
    // from every later cancellation pass.
    expect(s.runOf(s.middle.name)!.status).toBe('cancelling')

    paused.release()
    await middlePass
    await s.drain()

    expect(s.runOf(s.leaf.name)!.status).toBe('cancelled')
    expect(s.runOf(s.middle.name)!.status).toBe('cancelled')
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect(s.leafRan()).toBe(0)
    expect(s.runtime.inspect().continueRunCommands).toHaveLength(0)
    expect(s.runtime.inspect().activityCommands).toHaveLength(0)
  })

  it('starts no child run once the pass can see the cancellation', async () => {
    const s = setup()
    const client = createWorkflowRuntimeClient(s.runtime)
    const run = await client.start(s.parent, 'hi')
    await runWorkflowWorker({ ...s.base, workflows: [s.parentImplementation] })

    const paused = gate()
    const store: WorkflowStore = {
      ...s.runtime.store,
      markRunRunning: async (params) => {
        const marked = await s.runtime.store.markRunRunning(params)
        await paused.pass()
        return marked
      },
    }
    const middlePass = runWorkflowWorker({
      ...s.base,
      store,
      workflows: [s.middleImplementation],
    })
    await paused.reached

    await client.cancel(run.id)
    await runWorkflowWorker({ ...s.base, workflows: [s.parentImplementation] })

    paused.release()
    await middlePass
    await s.drain()

    expect(s.runOf(s.leaf.name)).toBeUndefined()
    expect(s.runOf(s.middle.name)!.status).toBe('cancelled')
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect(s.leafRan()).toBe(0)
  })

  it('cancels an idle child workflow and its descendants in the same pass', async () => {
    const s = setup()
    const client = createWorkflowRuntimeClient(s.runtime)
    const run = await client.start(s.parent, 'hi')
    // No execution worker runs, so the leaf sits on its activity.
    await runWorkflowWorker({ ...s.base, workflows: s.all })

    await client.cancel(run.id)
    const parentOnly = [s.parentImplementation]
    await runWorkflowWorker({ ...s.base, workflows: parentOnly })

    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect(s.runOf(s.middle.name)!.status).toBe('cancelled')
    expect(s.runOf(s.leaf.name)!.status).toBe('cancelled')
    expect(s.runtime.inspect().activityCommands).toHaveLength(0)
    await s.drain()
    expect(s.leafRan()).toBe(0)
  })

  it('serializes a run timeout with the child coordinator the same way', async () => {
    const s = setup({ parentTimeout: '20ms' })
    const client = createWorkflowRuntimeClient(s.runtime)
    const run = await client.start(s.parent, 'hi')
    await runWorkflowWorker({ ...s.base, workflows: [s.parentImplementation] })

    const paused = gate()
    const store: WorkflowStore = {
      ...s.runtime.store,
      ensureChildRun: async (params) => {
        await paused.pass()
        return s.runtime.store.ensureChildRun(params)
      },
    }
    const middlePass = runWorkflowWorker({
      ...s.base,
      store,
      workflows: [s.middleImplementation],
    })
    await paused.reached

    await wait(30)
    expect(
      await timeoutExpiredWorkflowRuns({ ...s.runtime, workflows: s.all }),
    ).toStrictEqual({ timedOut: 1 })
    expect(s.runOf(s.middle.name)!.status).toBe('cancelling')

    paused.release()
    await middlePass
    await s.drain()

    expect((await client.get(run.id))!.run.status).toBe('failed')
    expect(s.runOf(s.middle.name)!.status).toBe('cancelled')
    expect(s.runOf(s.leaf.name)!.status).toBe('cancelled')
    expect(s.leafRan()).toBe(0)
  })
})

describe('manual retry over an activity that settled before its node', () => {
  it('completes the node from the completed child and advances', async () => {
    let firstRan = 0
    const workflow = defineWorkflow({
      name: 'review5.retry.workflow',
      input: text,
      output: text,
      timeout: '20ms',
    })
      .activity('first', { input: text, output: text })
      .activity('second', { input: text, output: text })
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .first(async (input) => {
        firstRan += 1
        return `${input}-first`
      })
      .second(async (input) => `${input}-second`, {
        input: ({ first }) => first,
      })
      .finish(({ second }) => second)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [],
      workerId: 'review5',
      reaping: false,
      runTimeouts: false,
    } as const
    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)

    // The attempt and its child settle; the node completion is still pending
    // when the run times out.
    const paused = gate()
    const execution = runExecutionWorker({
      ...workers,
      store: {
        ...runtime.store,
        completeNode: async (params) => {
          await paused.pass()
          return runtime.store.completeNode(params)
        },
      },
    })
    await paused.reached
    await wait(30)
    expect(
      await timeoutExpiredWorkflowRuns({
        ...runtime,
        workflows: [implementation],
      }),
    ).toStrictEqual({ timedOut: 1 })
    paused.release()
    await execution
    await runWorkflowWorker(workers)

    const timedOut = (await client.get(run.id))!
    expect(timedOut.run.status).toBe('failed')
    expect(timedOut.nodes.find((node) => node.name === 'first')!.status).toBe(
      'cancelled',
    )
    expect(
      timedOut.children.find((child) => child.nodeName === 'first')!.status,
    ).toBe('completed')

    await client.retry(run.id)
    for (let pass = 0; pass < 3; pass += 1) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }

    const retried = (await client.get(run.id))!
    expect(retried.run.status).toBe('completed')
    expect(retried.run.output).toBe('hi-first-second')
    expect(firstRan).toBe(1)
  })
})
