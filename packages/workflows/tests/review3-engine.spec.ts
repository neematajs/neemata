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
import { timeoutExpiredWorkflowRuns } from '../src/runtime/worker.ts'

const text = z.string()
const HOUR_MS = 3_600_000

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

describe('run timeout sweep', () => {
  it('still wakes the parent when the wake after failing the child is lost', async () => {
    const child = defineWorkflow({
      name: 'review3.timeout.child',
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
      name: 'review3.timeout.parent',
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
      workerId: 'review3',
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

describe('coordinator redispatch of a retry', () => {
  it('keeps the backoff of a parallel task member when a sibling completes before its dispatch', async () => {
    const slow = defineTask({ name: 'review3.slow', input: text, output: text })
    const slowImplementation = implementTask(slow, {
      pool: 'test',
      handler: async () => {
        throw new Error('always fails')
      },
    })
    const fast = defineTask({ name: 'review3.fast', input: text, output: text })
    const fastImplementation = implementTask(fast, {
      pool: 'test',
      handler: async (input) => input,
    })
    const workflow = defineWorkflow({
      name: 'review3.backoff.task',
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
      workerId: 'review3',
    }
    await client.start(workflow, 'x')
    await runWorkflowWorker(workers)

    const claimed = (await runtime.attemptExecutor.claim({
      workerId: 'review3',
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
      name: 'review3.backoff.activity',
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
      workerId: 'review3',
    }
    await client.start(workflow, 'x')
    await runWorkflowWorker(workers)

    // Claims come in dispatch order, so take both and run `slow` by hand.
    const claims = [
      (await runtime.attemptExecutor.claim({
        workerId: 'review3',
        workflowNames: [workflow.name],
        taskNames: [],
        leaseMs: 30_000,
      }))!,
      (await runtime.attemptExecutor.claim({
        workerId: 'review3',
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

describe('reserved case keys', () => {
  const task = defineTask({ name: 'review3.member', input: text, output: text })
  const reserved = ['__proto__', 'constructor', 'prototype']

  it.each(reserved)('rejects the parallel member key %s', (key) => {
    expect(() =>
      defineWorkflow({ name: 'review3.reserved.parallel', input: text })
        // A computed key is an own property even when it spells `__proto__`.
        .parallel('pair', (h) => ({ [key]: h.task(task), ok: h.task(task) })),
    ).toThrow(`Workflow parallel member key cannot be "${key}": pair`)
  })

  it.each(reserved)('rejects the branch case key %s', (key) => {
    expect(() =>
      defineWorkflow({ name: 'review3.reserved.branch', input: text }).branch(
        'choice',
        {
          output: text,
          cases: (h) => ({ [key]: h.task(task), ok: h.task(task) }),
        },
      ),
    ).toThrow(`Workflow branch case key cannot be "${key}": choice`)
  })

  it('refuses to implement a hand-built definition with a reserved member key', () => {
    const built = defineWorkflow({
      name: 'review3.reserved.implement',
      input: text,
    })
      .parallel('pair', (h) => ({ ok: h.task(task) }))
      .build()
    const [node] = built.nodes
    const member = node.cases.ok
    const workflow = {
      ...built,
      nodes: [{ ...node, cases: { ['__proto__']: member, ok: member } }],
    } as unknown as typeof built

    expect(() =>
      implementWorkflow(workflow, { pool: 'test' }).pair(
        ({ task: run }) =>
          ({ ['__proto__']: run(task), ok: run(task) }) as never,
      ),
    ).toThrow('Workflow parallel case key cannot be "__proto__": pair')
  })
})
