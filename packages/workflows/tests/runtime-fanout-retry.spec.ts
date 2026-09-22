import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import {
  defineWorkflow,
  implementWorkflow,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/effect/index.ts'
import {
  defineTask as defineStandardTask,
  defineWorkflow as defineStandardWorkflow,
  implementTask as implementStandardTask,
  implementWorkflow as implementStandardWorkflow,
} from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  memberChildKey,
  runExecutionWorker as runStoredExecutionWorker,
  runWorkflowWorker as runStoredWorkflowWorker,
  startWorkflowRun,
} from '../src/runtime/index.ts'
import {
  reapDeadWorkflowCommands,
  timeoutExpiredWorkflowRuns,
} from '../src/runtime/worker.ts'
import { fromPromise } from './support/effect.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Regression coverage for the issue #241 fan-out/retry state model:
 * per-member retry budgets, retries that keep their member binding, truthful
 * run statuses, and dead-lettered commands failing their runs.
 */
describe('workflow fan-out retry state model', () => {
  const createTestContext = () => {
    return Context.empty()
  }

  const memberInput = Schema.Struct({ scenario: Schema.String })
  const memberOutput = Schema.Struct({ text: Schema.String })

  const defineParallelWorkflow = (name: string) =>
    defineWorkflow({
      name,
      input: Schema.Struct({ scenario: Schema.String }),
    })
      .parallel('members', (helpers) => ({
        a: helpers.activity({
          input: memberInput,
          output: memberOutput,
          retry: { attempts: 3, delay: '5ms' },
        }),
        b: helpers.activity({
          input: memberInput,
          output: memberOutput,
          retry: { attempts: 3, delay: '5ms' },
        }),
        c: helpers.activity({
          input: memberInput,
          output: memberOutput,
          retry: { attempts: 3, delay: '5ms' },
        }),
        d: helpers.activity({
          input: memberInput,
          output: memberOutput,
          retry: { attempts: 3, delay: '5ms' },
        }),
      }))
      .build()

  const implementParallelWorkflow = (
    workflow: ReturnType<typeof defineParallelWorkflow>,
    failures: Record<string, number>,
  ) => {
    const remaining = new Map(Object.entries(failures))
    const memberHandler = (member: string) => (input: { scenario: string }) =>
      fromPromise(async () => {
        const left = remaining.get(member) ?? 0
        if (left > 0) {
          remaining.set(member, left - 1)
          throw new Error(`transient failure of [${member}]`)
        }
        return { text: `${member}:${input.scenario}` }
      })
    return implementWorkflow(workflow, { pool: 'test' })
      .members(({ activity }) => ({
        a: activity(memberHandler('a')),
        b: activity(memberHandler('b')),
        c: activity(memberHandler('c')),
        d: activity(memberHandler('d')),
      }))
      .finish(({ members }) => fromPromise(() => members))
  }

  const drive = async (
    runtime: ReturnType<typeof createInMemoryWorkflowRuntime>,
    implementation: ReturnType<typeof implementParallelWorkflow>,
    runId: string,
    rounds: number,
  ) => {
    for (let round = 0; round < rounds; round += 1) {
      await runWorkflowWorker({
        ...runtime,
        context: createTestContext(),
        workflows: [implementation],
        workerId: `coordinator-${round}`,
      })
      await runExecutionWorker({
        tasks: [],
        ...runtime,
        context: createTestContext(),
        workflows: [implementation],
        workerId: `activity-${round}`,
      })
      const snapshot = await runtime.store.loadRunSnapshot(runId)
      if (
        snapshot &&
        ['completed', 'failed', 'cancelled'].includes(snapshot.run.status)
      ) {
        return snapshot
      }
      await wait(10)
    }
    return await runtime.store.loadRunSnapshot(runId)
  }

  it('gives every parallel member its own retry budget (issue #241 / 2a)', async () => {
    const workflow = defineParallelWorkflow('fanout.per-member-budget')
    // Under the old node-global attempt counter, member d's first execution
    // already occupied attempt number 4 >= 3, so one transient failure of d
    // failed the whole node without any retry.
    const implementation = implementParallelWorkflow(workflow, { d: 1 })
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow,
      input: { scenario: 'alpha' },
    })

    const snapshot = await drive(runtime, implementation, run.id, 20)
    expect(snapshot?.run.status).toBe('completed')
    expect(snapshot?.run.output).toStrictEqual(
      Object.assign(Object.create(null), {
        a: { text: 'a:alpha' },
        b: { text: 'b:alpha' },
        c: { text: 'c:alpha' },
        d: { text: 'd:alpha' },
      }),
    )

    const dAttempts = snapshot!.attempts
      .filter((attempt) => attempt.childKey === memberChildKey('d'))
      .sort((left, right) => left.attemptNumber - right.attemptNumber)
    expect(dAttempts.map((attempt) => attempt.attemptNumber)).toStrictEqual([
      1, 2,
    ])
    expect(dAttempts[0]?.status).toBe('failed')
    expect(dAttempts[1]?.status).toBe('completed')

    // Sibling budgets are untouched: one execution each, numbered from 1.
    for (const member of ['a', 'b', 'c']) {
      const attempts = snapshot!.attempts.filter(
        (attempt) => attempt.childKey === memberChildKey(member),
      )
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.attemptNumber).toBe(1)
    }
  })

  it('keeps retries bound to their member so they execute instead of wedging (issue #241 / 2b)', async () => {
    const workflow = defineParallelWorkflow('fanout.retry-keeps-member')
    // Under the old model the retry attempt lost its member identity, the
    // worker released the command forever, and the run hung.
    const implementation = implementParallelWorkflow(workflow, { a: 1 })
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow,
      input: { scenario: 'beta' },
    })

    const snapshot = await drive(runtime, implementation, run.id, 20)
    expect(snapshot?.run.status).toBe('completed')

    const retry = snapshot!.attempts.find(
      (attempt) =>
        attempt.childKey === memberChildKey('a') && attempt.attemptNumber === 2,
    )
    expect(retry?.status).toBe('completed')
    expect(retry?.output).toStrictEqual({ text: 'a:beta' })

    const aChild = snapshot!.children.find(
      (child) => child.childKey === memberChildKey('a'),
    )
    expect(aChild?.status).toBe('completed')
    expect(aChild?.attemptCount).toBe(2)
    expect(await runtime.store.listDeadCommands()).toHaveLength(0)
  })

  it('reports truthful run statuses across the lifecycle (issue #241 / 1)', async () => {
    const workflow = defineWorkflow({
      name: 'fanout.status-truth',
      input: Schema.Struct({ scenario: Schema.String }),
    })
      .activity('step', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .step((input) =>
        fromPromise(async () => ({ text: `step:${input.scenario}` })),
      )
      .finish(({ step }) => fromPromise(() => step))
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow,
      input: { scenario: 'gamma' },
    })
    expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
      'queued',
    )

    // The coordinator pass dispatches the activity attempt: the run has local
    // work, so it must report running — never queued (issue #241 problem 1).
    await runWorkflowWorker({
      ...runtime,
      context: createTestContext(),
      workflows: [implementation],
      workerId: 'coordinator-status',
    })
    expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
      'running',
    )

    await runExecutionWorker({
      tasks: [],
      ...runtime,
      context: createTestContext(),
      workflows: [implementation],
      workerId: 'activity-status',
    })
    await runWorkflowWorker({
      ...runtime,
      context: createTestContext(),
      workflows: [implementation],
      workerId: 'coordinator-status-2',
    })
    expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
      'completed',
    )
  })

  it('marks a run waiting while it is parked on a child workflow', async () => {
    const childWorkflow = defineWorkflow({
      name: 'fanout.waiting-child',
      input: Schema.Struct({ scenario: Schema.String }),
    })
      .activity('inner', { input: memberInput, output: memberOutput })
      .build()
    const parentWorkflow = defineWorkflow({
      name: 'fanout.waiting-parent',
      input: Schema.Struct({ scenario: Schema.String }),
    })
      .workflow('child', childWorkflow)
      .build()

    const parentImplementation = implementWorkflow(parentWorkflow, {
      pool: 'test',
    })
      .child(childWorkflow)
      .finish(({ child }) => fromPromise(() => child))
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow: parentWorkflow,
      input: { scenario: 'delta' },
    })

    // First coordination pass parks the parent on its child run: honest
    // status is waiting, not queued and not running.
    await runWorkflowWorker({
      ...runtime,
      context: createTestContext(),
      workflows: [parentImplementation],
      workerId: 'coordinator-parent',
    })
    expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
      'waiting',
    )
  })

  it('dead-letters unroutable attempts and the reaper fails the run (issue #241 / 3)', async () => {
    const declaredWorkflow = defineWorkflow({
      name: 'fanout.unroutable',
      input: Schema.Struct({ scenario: Schema.String }),
    })
      .activity('step', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    const implementation = implementWorkflow(declaredWorkflow, { pool: 'test' })
      .step((input) =>
        fromPromise(async () => ({ text: `step:${input.scenario}` })),
      )
      .finish(({ step }) => fromPromise(() => step))

    // Same workflow name, drifted definition: the node's activity was renamed
    // in the deployed worker, so the dispatched command can never resolve.
    const driftedWorkflow = defineWorkflow({
      name: 'fanout.unroutable',
      input: Schema.Struct({ scenario: Schema.String }),
    })
      .activity('stepRenamed', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    const driftedImplementation = implementWorkflow(driftedWorkflow, {
      pool: 'test',
    })
      .stepRenamed((input) =>
        fromPromise(async () => ({ text: input.scenario })),
      )
      .finish((outputs) => fromPromise(() => outputs))

    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow: declaredWorkflow,
      input: { scenario: 'omega' },
    })
    await runWorkflowWorker({
      ...runtime,
      context: createTestContext(),
      workflows: [implementation],
      workerId: 'coordinator-drift',
      reaping: false,
      runTimeouts: false,
    })

    // The drifted worker claims the command but cannot resolve the activity;
    // unroutable releases count toward dead-lettering instead of looping
    // forever (the old model re-claimed every 50ms indefinitely).
    const command = runtime.inspect().activityCommands[0]?.payload
    expect(command).toBeDefined()
    await runExecutionWorker({
      tasks: [],
      ...runtime,
      context: createTestContext(),
      workflows: [driftedImplementation],
      workerId: 'drifted-worker',
      reaping: false,
    })

    const dead = await runtime.store.listDeadCommands()
    expect(dead).toHaveLength(1)
    expect(dead[0]?.lastError?.message).toContain(
      'No activity implementation for',
    )

    // The reaper turns the dead letter into a terminal run instead of a
    // zombie stuck in running/waiting forever.
    const { reaped } = await reapDeadWorkflowCommands({
      store: runtime.store,
      attemptExecutor: runtime.attemptExecutor,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
    })
    expect(reaped).toBe(1)
    await runWorkflowWorker({
      ...runtime,
      context: createTestContext(),
      workflows: [implementation],
      workerId: 'coordinator-reap',
      reaping: false,
      runTimeouts: false,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('failed')
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.children[0]?.status).toBe('failed')

    // Reaped commands stay visible for audit/requeue but leave the sweep.
    expect(await runtime.store.listDeadCommands()).toHaveLength(1)
    expect(await runtime.store.listUnreapedDeadCommands()).toHaveLength(0)
    const again = await reapDeadWorkflowCommands({
      store: runtime.store,
      attemptExecutor: runtime.attemptExecutor,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
    })
    expect(again.reaped).toBe(0)
  })

  it('fails runs that exceed their definition timeout', async () => {
    const workflow = defineWorkflow({
      name: 'fanout.run-timeout',
      input: Schema.Struct({ scenario: Schema.String }),
      timeout: '30ms',
    })
      .activity('step', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    // No activity worker ever runs, so without the sweep this run would sit
    // in running forever.
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .step((input) => fromPromise(async () => ({ text: input.scenario })))
      .finish(({ step }) => fromPromise(() => step))
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow,
      input: { scenario: 'late' },
    })
    await runWorkflowWorker({
      ...runtime,
      context: createTestContext(),
      workflows: [implementation],
      workerId: 'coordinator-timeout',
      reaping: false,
      runTimeouts: false,
    })

    await wait(40)
    const { timedOut } = await timeoutExpiredWorkflowRuns({
      store: runtime.store,
      attemptExecutor: runtime.attemptExecutor,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflows: [implementation],
    })
    expect(timedOut).toBe(1)

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('failed')
    expect(snapshot?.run.error?.message).toContain('timed out after [30ms]')
    expect(snapshot?.nodes[0]?.status).toBe('cancelled')
  })
})

describe('task node retry overrides', () => {
  const text = z.string()

  // The task itself declares no policy, so only the node's can retry it.
  function failsFirstCallPerInput() {
    const seen = new Set<string>()
    const task = defineStandardTask({
      name: 'retry-override.once',
      input: text,
      output: text,
    })
    const implementation = implementStandardTask(task, {
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

  async function drain(
    workers: Parameters<typeof runStoredExecutionWorker>[0],
  ) {
    for (let round = 0; round < 6; round++) {
      await runStoredWorkflowWorker(workers)
      await runStoredExecutionWorker(workers)
    }
  }

  it('retries a task node with the policy the node declares', async () => {
    const { task, implementation: taskImplementation } =
      failsFirstCallPerInput()
    const workflow = defineStandardWorkflow({
      name: 'retry-override.node',
      input: text,
      output: text,
    })
      .task('step', task, { retry: { attempts: 2 } })
      .build()
    const implementation = implementStandardWorkflow(workflow, { pool: 'test' })
      .step(task)
      .finish(({ step }) => step)

    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, 'a')
    await drain({
      ...runtime,
      workflows: [implementation],
      tasks: [taskImplementation],
      workerId: 'fanout-retry',
    })

    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toBe('A')
  })

  it('retries parallel task members and map items with their declared policy', async () => {
    const { task, implementation: taskImplementation } =
      failsFirstCallPerInput()
    const workflow = defineStandardWorkflow({
      name: 'retry-override.fanout',
      input: text,
      output: z.array(text),
    })
      .parallel('pair', (h) => ({
        left: h.task(task, { retry: { attempts: 2 } }),
      }))
      .mapTask('each', task, { item: text, retry: { attempts: 2 } })
      .build()
    const implementation = implementStandardWorkflow(workflow, { pool: 'test' })
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
      workerId: 'fanout-retry',
    })

    const snapshot = (await client.get(run.id))!
    expect(snapshot.run.status).toBe('completed')
    expect(snapshot.run.output).toEqual(['P', 'M1', 'M2'])
  })
})
