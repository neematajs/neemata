import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  createHandlerRunner,
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runActivityAttempt,
  runExecutionWorker,
  runTaskAttempt,
  runWorkflowWorker,
} from '../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../src/runtime/worker.ts'

const LEASE_MS = 50
const LEASE_EXPIRED_MS = 120
const HOUR_MS = 3_600_000

const text = z.string()
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type Runtime = ReturnType<typeof createInMemoryWorkflowRuntime>

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

async function claimTask(runtime: Runtime, taskName: string) {
  const claimed = await runtime.attemptExecutor.claim({
    workerId: 'reaper',
    workflowNames: [],
    taskNames: [taskName],
    leaseMs: 30_000,
  })
  expect(claimed).not.toBeNull()
  return claimed!
}

const claimAttempt = (
  runtime: Runtime,
  names: { readonly workflowNames?: string[]; readonly taskNames?: string[] },
  leaseMs = LEASE_MS,
) =>
  runtime.attemptExecutor.claim({
    workerId: 'reaper',
    workflowNames: names.workflowNames ?? [],
    taskNames: names.taskNames ?? [],
    leaseMs,
  })

/** The expired claim exhausts `maxDeliveries: 1`, so reclaiming dead-letters it. */
async function deadLetter(
  runtime: Runtime,
  names: Parameters<typeof claimAttempt>[1],
) {
  await wait(LEASE_EXPIRED_MS)
  await expect(claimAttempt(runtime, names)).resolves.toBeNull()
  await expect(
    runtime.store.listUnreapedDeadCommands({}),
  ).resolves.toHaveLength(1)
}

function flakyTask() {
  let calls = 0
  const task = defineTask({
    name: 'reaper.flaky',
    input: text,
    output: text,
    retry: { attempts: 2 },
  })
  const implementation = implementTask(task, {
    pool: 'test',
    handler: async (input) => {
      calls += 1
      if (calls === 1) throw new Error('first try fails')
      return `${input}:${calls}`
    },
  })
  return { task, implementation, calls: () => calls }
}

function parentOfTask(handler: (input: string) => Promise<string>) {
  const task = defineTask({ name: 'reaper.child', input: text, output: text })
  const taskImplementation = implementTask(task, { pool: 'test', handler })
  const workflow = defineWorkflow({
    name: 'reaper.parent',
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

describe('task attempt redelivery', () => {
  it('replays the parent wake lost after a child task run completed', async () => {
    const task = defineTask({
      name: 'redelivery.child',
      input: text,
      output: text,
    })
    const taskImplementation = implementTask(task, {
      pool: 'test',
      handler: async (input) => `${input}!`,
    })
    const workflow = defineWorkflow({
      name: 'redelivery.parent',
      input: text,
      output: text,
    })
      .task('child', task)
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .child(task)
      .finish(({ child }) => child)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [taskImplementation],
      workerId: 'reaper',
    }
    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)

    const claimed = await claimTask(runtime, task.name)
    const attempt = {
      ...workers,
      handlers: createHandlerRunner(),
      claimed,
    }
    // The worker dies between completeRun and the parent's continue command.
    await expect(
      runTaskAttempt({
        ...attempt,
        runCoordinationExecutor: {
          ...runtime.runCoordinationExecutor,
          enqueue: failingOnce((command) =>
            runtime.runCoordinationExecutor.enqueue(command),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)

    // Redelivery of the still-unacknowledged command finds the run terminal.
    await runTaskAttempt(attempt)
    expect(
      runtime.inspect().continueRunCommands.map(({ payload }) => payload.runId),
    ).toEqual([run.id])
    expect(runtime.inspect().taskCommands).toHaveLength(0)

    await runWorkflowWorker(workers)
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toBe('hi!')
  })

  it('dispatches a retry whose command was lost after its attempt was created', async () => {
    const { task, implementation } = flakyTask()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'reaper',
    }
    const run = await client.start(task, 'x')
    const claimed = await claimTask(runtime, task.name)
    const attempt = { ...workers, handlers: createHandlerRunner(), claimed }

    await expect(
      runTaskAttempt({
        ...attempt,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchTask: failingOnce((command, options) =>
            runtime.attemptExecutor.dispatchTask(command, options),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    expect(
      runtime.inspect().attempts.map(({ status }) => status),
    ).toStrictEqual(['failed', 'started'])
    // Only the old, claimed command is left: nothing would run attempt 2.
    expect(runtime.inspect().taskCommands).toHaveLength(0)

    await runTaskAttempt(attempt)
    const [replacement] = runtime.inspect().taskCommands
    expect(replacement?.payload.attemptId).toBe(
      runtime.inspect().attempts[1]?.id,
    )
    expect(runtime.inspect().taskCommands).toHaveLength(1)

    await runExecutionWorker(workers)
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toBe('x:2')
  })

  it('spends the retry budget when the worker died before creating the retry', async () => {
    const { task, implementation } = flakyTask()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'reaper',
    }
    const run = await client.start(task, 'x')
    const claimed = await claimTask(runtime, task.name)
    const attempt = { ...workers, handlers: createHandlerRunner(), claimed }

    await expect(
      runTaskAttempt({
        ...attempt,
        store: {
          ...runtime.store,
          createAttempt: failingOnce((params) =>
            runtime.store.createAttempt(params),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    expect(
      runtime.inspect().attempts.map(({ status }) => status),
    ).toStrictEqual(['failed'])

    await runTaskAttempt(attempt)
    await runExecutionWorker(workers)
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toBe('x:2')
  })
})

describe('retry after a claim takeover', () => {
  it('shares the retry the new claimant created instead of superseding it', async () => {
    const { task, implementation, calls } = flakyTask()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'reaper',
    }
    const run = await client.start(task, 'x')
    const names = { taskNames: [task.name] }
    const claimA = (await claimAttempt(runtime, names))!

    // A records the failure, then stalls past its lease before creating the
    // retry. B takes the claim over and recovers the retry in the meantime.
    const workerA = runTaskAttempt({
      ...workers,
      leaseMs: LEASE_MS,
      handlers: createHandlerRunner(),
      claimed: claimA,
      store: {
        ...runtime.store,
        createAttempt: async (params) => {
          await wait(LEASE_EXPIRED_MS)
          const claimB = (await claimAttempt(runtime, names, 30_000))!
          expect(claimB.id).toBe(claimA.id)
          await runTaskAttempt({
            ...workers,
            handlers: createHandlerRunner(),
            claimed: claimB,
          })
          expect(
            runtime.inspect().attempts.map(({ status }) => status),
          ).toStrictEqual(['failed', 'started'])
          return await runtime.store.createAttempt(params)
        },
      },
    })
    await expect(workerA).rejects.toThrow('Stale workflow command ack')

    expect(
      runtime.inspect().attempts.map(({ status }) => status),
    ).toStrictEqual(['failed', 'started'])
    expect(
      runtime.inspect().taskCommands.map(({ payload }) => payload.attemptId),
    ).toStrictEqual([runtime.inspect().attempts[1]!.id])

    await runExecutionWorker(workers)
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toBe('x:2')
    expect(snapshot.attempts.map(({ status }) => status)).toStrictEqual([
      'failed',
      'completed',
    ])
    expect(calls()).toBe(2)
  })
})

describe('reaping a dead command whose outcome was already recorded', () => {
  it('completes a task run whose worker died after settling the attempt', async () => {
    const task = defineTask({ name: 'reaper.solo', input: text, output: text })
    const implementation = implementTask(task, {
      pool: 'test',
      handler: async (input) => `${input}!`,
    })
    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(task, 'hi')
    const names = { taskNames: [task.name] }

    await expect(
      runTaskAttempt({
        ...runtime,
        tasks: [implementation],
        workerId: 'reaper',
        leaseMs: LEASE_MS,
        handlers: createHandlerRunner(),
        claimed: (await claimAttempt(runtime, names))!,
        store: {
          ...runtime.store,
          completeNode: failingOnce((params) =>
            runtime.store.completeNode(params),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    await deadLetter(runtime, names)
    expect((await client.get(run.id))!.run.status).toBe('running')

    await expect(reapDeadWorkflowCommands(runtime)).resolves.toEqual({
      reaped: 1,
    })
    const snapshot = (await client.get(run.id))!
    expect(snapshot.run).toMatchObject({ status: 'completed', output: 'hi!' })
    expect(snapshot.nodes[0]).toMatchObject({
      status: 'completed',
      output: 'hi!',
    })
    await expect(
      runtime.store.listUnreapedDeadCommands({}),
    ).resolves.toHaveLength(0)
  })

  it('replays the parent wake lost after a child task run completed', async () => {
    const { task, taskImplementation, workflow, implementation } = parentOfTask(
      async (input) => `${input}!`,
    )
    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [taskImplementation],
      workerId: 'reaper',
    }
    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)
    const names = { taskNames: [task.name] }

    await expect(
      runTaskAttempt({
        ...workers,
        leaseMs: LEASE_MS,
        handlers: createHandlerRunner(),
        claimed: (await claimAttempt(runtime, names))!,
        runCoordinationExecutor: {
          ...runtime.runCoordinationExecutor,
          enqueue: failingOnce((command) =>
            runtime.runCoordinationExecutor.enqueue(command),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    await deadLetter(runtime, names)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)

    await expect(reapDeadWorkflowCommands(runtime)).resolves.toEqual({
      reaped: 1,
    })
    expect(
      runtime.inspect().continueRunCommands.map(({ payload }) => payload.runId),
    ).toEqual([run.id])

    await runWorkflowWorker(workers)
    expect((await client.get(run.id))!.run).toMatchObject({
      status: 'completed',
      output: 'hi!',
    })
  })

  it('continues a workflow whose activity worker died after settling the attempt', async () => {
    const workflow = defineWorkflow({
      name: 'reaper.activity',
      input: text,
      output: text,
    })
      .activity('step', { input: text, output: text })
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .step((input) => `${input}!`, { input: (_outputs, input) => input })
      .finish(({ step }) => step)
    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [],
      workerId: 'reaper',
    }
    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)
    const names = { workflowNames: [workflow.name] }

    await expect(
      runActivityAttempt({
        ...workers,
        leaseMs: LEASE_MS,
        handlers: createHandlerRunner(),
        claimed: (await claimAttempt(runtime, names))!,
        store: {
          ...runtime.store,
          completeNode: failingOnce((params) =>
            runtime.store.completeNode(params),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    await deadLetter(runtime, names)

    await expect(reapDeadWorkflowCommands(runtime)).resolves.toEqual({
      reaped: 1,
    })
    await runWorkflowWorker(workers)
    expect((await client.get(run.id))!.run).toMatchObject({
      status: 'completed',
      output: 'hi!',
    })
  })

  it('dispatches a retry whose command was lost before the failed attempt dead-lettered', async () => {
    const { task, implementation } = flakyTask()
    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'reaper',
    }
    const run = await client.start(task, 'x')
    const names = { taskNames: [task.name] }

    await expect(
      runTaskAttempt({
        ...workers,
        leaseMs: LEASE_MS,
        handlers: createHandlerRunner(),
        claimed: (await claimAttempt(runtime, names))!,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchTask: failingOnce((command, options) =>
            runtime.attemptExecutor.dispatchTask(command, options),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    await deadLetter(runtime, names)
    // Dead commands stay listed; attempt 2 has none at all.
    const [failed, retry] = runtime.inspect().attempts
    const commandAttemptIds = () =>
      runtime.inspect().taskCommands.map(({ payload }) => payload.attemptId)
    expect(commandAttemptIds()).toStrictEqual([failed!.id])

    await expect(reapDeadWorkflowCommands(runtime)).resolves.toEqual({
      reaped: 1,
    })
    expect(commandAttemptIds()).toStrictEqual([failed!.id, retry!.id])

    await runExecutionWorker(workers)
    expect((await client.get(run.id))!.run).toMatchObject({
      status: 'completed',
      output: 'x:2',
    })
  })
})

describe('coordinator redispatch of a retry', () => {
  it('keeps the backoff of a parallel task member when a sibling completes before its dispatch', async () => {
    const slow = defineTask({
      name: 'redispatch.slow',
      input: text,
      output: text,
    })
    const slowImplementation = implementTask(slow, {
      pool: 'test',
      handler: async () => {
        throw new Error('always fails')
      },
    })
    const fast = defineTask({
      name: 'redispatch.fast',
      input: text,
      output: text,
    })
    const fastImplementation = implementTask(fast, {
      pool: 'test',
      handler: async (input) => input,
    })
    const workflow = defineWorkflow({
      name: 'redispatch.backoff.task',
      input: text,
      output: text,
    })
      .parallel('pair', (h) => ({
        slow: h.task(slow, { retry: { attempts: 2, delay: '1h' } }),
        fast: h.task(fast),
      }))
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .pair(({ task }) => ({ slow: task(slow), fast: task(fast) }))
      .finish(({ pair }) => pair.fast)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      workerId: 'reaper',
    }
    await client.start(workflow, 'x')
    await runWorkflowWorker(workers)

    const claimed = (await runtime.attemptExecutor.claim({
      workerId: 'reaper',
      workflowNames: [],
      taskNames: [slow.name],
      leaseMs: 30_000,
    }))!
    // The worker dies between creating the retry and dispatching it.
    await expect(
      runTaskAttempt({
        ...workers,
        tasks: [slowImplementation],
        handlers: createHandlerRunner(),
        claimed,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchTask: failingOnce((command, options) =>
            runtime.attemptExecutor.dispatchTask(command, options),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    const retry = runtime
      .inspect()
      .attempts.find(
        ({ retryAttemptNumber, status }) =>
          retryAttemptNumber === 2 && status === 'started',
      )!
    expect(retry).toBeDefined()

    // The sibling's completion wakes the parent, whose pass finds the retry.
    await runExecutionWorker({ ...workers, tasks: [fastImplementation] })
    await runWorkflowWorker(workers)

    const [command] = runtime
      .inspect()
      .taskCommands.filter(({ payload }) => payload.attemptId === retry.id)
    expect(command).toBeDefined()
    expect(command!.runAt).toBe(retry.dispatchedAt + HOUR_MS)
  })

  it('keeps the backoff of a parallel activity member', async () => {
    const workflow = defineWorkflow({
      name: 'redispatch.backoff.activity',
      input: text,
      output: text,
    })
      .parallel('pair', (h) => ({
        slow: h.activity({
          input: text,
          output: text,
          retry: { attempts: 2, delay: '1h' },
        }),
        fast: h.activity({ input: text, output: text }),
      }))
      .build()
    let failSlow = true
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .pair(({ activity }) => ({
        slow: activity(async (input) => {
          if (failSlow) throw new Error('always fails')
          return input
        }),
        fast: activity(async (input) => input),
      }))
      .finish(({ pair }) => pair.fast)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [],
      workerId: 'reaper',
    }
    await client.start(workflow, 'x')
    await runWorkflowWorker(workers)

    // Claims come in dispatch order, so take both and run `slow` by hand.
    const claims = [
      (await runtime.attemptExecutor.claim({
        workerId: 'reaper',
        workflowNames: [workflow.name],
        taskNames: [],
        leaseMs: 30_000,
      }))!,
      (await runtime.attemptExecutor.claim({
        workerId: 'reaper',
        workflowNames: [workflow.name],
        taskNames: [],
        leaseMs: 30_000,
      }))!,
    ]
    const slowClaim = claims.find(({ command }) =>
      command.childKey.includes('slow'),
    )!
    const fastClaim = claims.find((claim) => claim !== slowClaim)!
    const attempt = { ...workers, handlers: createHandlerRunner() }
    await expect(
      runActivityAttempt({
        ...attempt,
        claimed: slowClaim,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchActivity: failingOnce((command, options) =>
            runtime.attemptExecutor.dispatchActivity(command, options),
          ),
        },
      }),
    ).rejects.toThrow('injected write failure')
    failSlow = false
    const retry = runtime
      .inspect()
      .attempts.find(({ retryAttemptNumber }) => retryAttemptNumber === 2)!
    expect(retry.status).toBe('started')

    await runActivityAttempt({ ...attempt, claimed: fastClaim })
    await runWorkflowWorker(workers)

    const [command] = runtime
      .inspect()
      .activityCommands.filter(({ payload }) => payload.attemptId === retry.id)
    expect(command).toBeDefined()
    expect(command!.runAt).toBe(retry.dispatchedAt + HOUR_MS)
  })
})
