import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { CancellationPolicy } from '../src/index.ts'
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
  type WorkflowStore,
} from '../src/runtime/index.ts'
import {
  reapDeadWorkflowCommands,
  timeoutExpiredWorkflowRuns,
} from '../src/runtime/worker.ts'

const text = z.string()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function failingOnce<Args extends unknown[], T>(
  target: (...args: Args) => Promise<T>,
) {
  let failed = false
  return async (...args: Args): Promise<T> => {
    if (!failed) {
      failed = true
      throw new Error('injected write failure')
    }
    return target(...args)
  }
}

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

function parentOfTask(handler: (input: string) => Promise<string>) {
  const task = defineTask({
    name: 'cancellation.child',
    input: text,
    output: text,
  })
  const taskImplementation = implementTask(task, { pool: 'test', handler })
  const workflow = defineWorkflow({
    name: 'cancellation.parent',
    input: text,
    output: text,
  })
    .task('child', task)
    .build()
  const implementation = implementWorkflow(workflow, { pool: 'test' })
    .child(task)
    .finish(({ child }) => child)
  return { task, taskImplementation, workflow, implementation }
}

describe('child workflow cancellation policy', () => {
  const child = defineWorkflow({
    name: 'cancellation.detach.child',
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
        name: 'cancellation.detach.node',
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
        name: 'cancellation.detach.branch',
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
        name: 'cancellation.detach.parallel',
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
        name: 'cancellation.detach.map',
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
      workerId: 'cancellation',
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
      workerId: 'cancellation',
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

describe('cancelling a parent while its child workflow is mid-pass', () => {
  function setup(options: { readonly parentTimeout?: '20ms' } = {}) {
    let leafRan = 0
    const leaf = defineWorkflow({
      name: 'cancellation.mid-pass.leaf',
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
      name: 'cancellation.mid-pass.middle',
      input: text,
      output: text,
    })
      .workflow('sub', leaf)
      .build()
    const middleImplementation = implementWorkflow(middle, { pool: 'test' })
      .sub(leaf)
      .finish(({ sub }) => sub)
    const parent = defineWorkflow({
      name: 'cancellation.mid-pass.parent',
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
      workerId: 'cancellation',
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

describe('cancelling a child task run', () => {
  it('replays the parent wake when the first cancel failed to enqueue it', async () => {
    const { workflow, implementation, taskImplementation } = parentOfTask(
      async (input) => input,
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [taskImplementation],
      workerId: 'cancellation',
    }
    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)
    const childRunId = (await client.get(run.id))!.children[0]!.childRunId!
    expect(runtime.inspect().taskCommands).toHaveLength(1)

    const flaky = createWorkflowRuntimeClient({
      ...runtime,
      runCoordinationExecutor: {
        ...runtime.runCoordinationExecutor,
        enqueue: failingOnce((command) =>
          runtime.runCoordinationExecutor.enqueue(command),
        ),
      },
    })
    await expect(flaky.cancel(childRunId)).rejects.toThrow(
      'injected write failure',
    )
    // The child is terminal and its command is gone: only a repeated cancel
    // can still tell the parent.
    expect((await client.get(childRunId))!.run.status).toBe('cancelled')
    expect(runtime.inspect().taskCommands).toHaveLength(0)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)

    await expect(flaky.cancel(childRunId)).resolves.toMatchObject({
      status: 'cancelled',
    })
    expect(
      runtime.inspect().continueRunCommands.map(({ payload }) => payload.runId),
    ).toEqual([run.id])

    await runWorkflowWorker(workers)
    expect((await client.get(run.id))!.run.status).not.toBe('waiting')
  })
})

describe('activity attempt of a cancelling run', () => {
  it('does not run the handler once cancellation was requested', async () => {
    const workflow = defineWorkflow({
      name: 'cancellation.activity-attempt',
      input: z.string(),
      output: z.string(),
    })
      .activity('step', { input: z.string(), output: z.string() })
      .build()
    let calls = 0
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .step((input) => {
        calls++
        return input
      })
      .finish(({ step }) => step)
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [],
      workerId: 'cancellation',
    }

    const run = await client.start(workflow, 'hi')
    // Dispatches the activity; its command now waits for an execution worker.
    await runWorkflowWorker(workers)
    await client.cancel(run.id)
    // The execution worker gets there before the cancellation's continuation.
    await runExecutionWorker(workers)

    expect(calls).toBe(0)
    await runWorkflowWorker(workers)
    await runExecutionWorker(workers)
    const snapshot = await client.get(run.id)
    expect(snapshot?.run.status).toBe('cancelled')
    expect(snapshot?.attempts.map((attempt) => attempt.status)).not.toContain(
      'completed',
    )
    expect(calls).toBe(0)
  })
})
