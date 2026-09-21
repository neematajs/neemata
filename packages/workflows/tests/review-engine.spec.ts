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
  runExecutionWorker,
  runTaskAttempt,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

const text = z.string()

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

async function claimTask(
  runtime: ReturnType<typeof createInMemoryWorkflowRuntime>,
  taskName: string,
) {
  const claimed = await runtime.attemptExecutor.claim({
    workerId: 'review',
    workflowNames: [],
    taskNames: [taskName],
    leaseMs: 30_000,
  })
  expect(claimed).not.toBeNull()
  return claimed!
}

describe('task attempt redelivery', () => {
  it('replays the parent wake lost after a child task run completed', async () => {
    const task = defineTask({ name: 'review.child', input: text, output: text })
    const taskImplementation = implementTask(task, {
      pool: 'test',
      handler: async (input) => `${input}!`,
    })
    const workflow = defineWorkflow({
      name: 'review.parent',
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
      workerId: 'review',
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

  function flakyTask() {
    let calls = 0
    const task = defineTask({
      name: 'review.flaky',
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
    return { task, implementation }
  }

  it('dispatches a retry whose command was lost after its attempt was created', async () => {
    const { task, implementation } = flakyTask()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [],
      tasks: [implementation],
      workerId: 'review',
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
      workerId: 'review',
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

describe('task node retry overrides', () => {
  // The task itself declares no policy, so only the node's can retry it.
  function failsFirstCallPerInput() {
    const seen = new Set<string>()
    const task = defineTask({ name: 'review.once', input: text, output: text })
    const implementation = implementTask(task, {
      pool: 'test',
      handler: async (input) => {
        if (!seen.has(input)) {
          seen.add(input)
          throw new Error(`first try fails [${input}]`)
        }
        return input.toUpperCase()
      },
    })
    return { task, implementation }
  }

  async function drain(workers: Parameters<typeof runExecutionWorker>[0]) {
    for (let round = 0; round < 6; round++) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }
  }

  it('retries a task node with the policy the node declares', async () => {
    const { task, implementation: taskImplementation } =
      failsFirstCallPerInput()
    const workflow = defineWorkflow({
      name: 'review.retry.node',
      input: text,
      output: text,
    })
      .task('step', task, { retry: { attempts: 2 } })
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .step(task)
      .finish(({ step }) => step)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, 'a')
    await drain({
      ...runtime,
      workflows: [implementation],
      tasks: [taskImplementation],
      workerId: 'review',
    })

    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toBe('A')
  })

  it('retries parallel task members and map items with their declared policy', async () => {
    const { task, implementation: taskImplementation } =
      failsFirstCallPerInput()
    const workflow = defineWorkflow({
      name: 'review.retry.fanout',
      input: text,
      output: z.array(text),
    })
      .parallel('pair', (h) => ({
        left: h.task(task, { retry: { attempts: 2 } }),
      }))
      .mapTask('each', task, { item: text, retry: { attempts: 2 } })
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .pair(({ task: member }) => ({ left: member(task) }))
      .each(task, {
        items: () => ['m1', 'm2'],
        input: (_outputs, item) => item,
      })
      .finish(({ pair, each }) => [
        pair.left,
        ...each.items.map(({ output }) => output),
      ])

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, 'p')
    await drain({
      ...runtime,
      workflows: [implementation],
      tasks: [taskImplementation],
      workerId: 'review',
    })

    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toEqual(['P', 'M1', 'M2'])
  })
})

describe('workflow contract', () => {
  it('compares a branch case output with the branch output as a whole', () => {
    const mixedTask = defineTask({
      name: 'review.mixed',
      input: text,
      output: z.union([z.string(), z.number()]),
    })
    const textTask = defineTask({
      name: 'review.text',
      input: text,
      output: text,
    })

    defineWorkflow({ name: 'review.branch', input: text })
      .branch('choice', {
        output: text,
        cases: (h) => ({
          text: h.task(textTask),
          // @ts-expect-error string | number does not satisfy a string branch
          mixed: h.task(mixedTask),
        }),
      })
      .build()
  })

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the reserved node name %s',
    (name) => {
      expect(() =>
        defineWorkflow({ name: 'review.reserved', input: text }).activity(
          name,
          { input: text, output: text },
        ),
      ).toThrow(`Workflow node name cannot be "${name}"`)
    },
  )
})
