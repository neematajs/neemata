import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  memberChildKey,
  runActivityWorker,
  runWorkflowWorker,
  startWorkflowRun,
} from '../src/runtime/index.ts'
import {
  reapDeadWorkflowCommands,
  timeoutExpiredWorkflowRuns,
} from '../src/runtime/worker.ts'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Regression coverage for the issue #241 fan-out/retry state model:
 * per-member retry budgets, retries that keep their member binding, truthful
 * run statuses, and dead-lettered commands failing their runs.
 */
describe('workflow fan-out retry state model', () => {
  const createTestContainer = () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    return new Container({ logger })
  }

  const memberInput = t.object({ scenario: t.string() })
  const memberOutput = t.object({ text: t.string() })

  const defineParallelWorkflow = (name: string) =>
    defineWorkflow({
      name,
      input: t.object({ scenario: t.string() }),
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
    const memberHandler =
      (member: string) =>
      async (_ctx: unknown, input: { scenario: string }) => {
        const left = remaining.get(member) ?? 0
        if (left > 0) {
          remaining.set(member, left - 1)
          throw new Error(`transient failure of [${member}]`)
        }
        return { text: `${member}:${input.scenario}` }
      }
    return implementWorkflow(workflow)
      .members(({ activity }) => ({
        a: activity(memberHandler('a')),
        b: activity(memberHandler('b')),
        c: activity(memberHandler('c')),
        d: activity(memberHandler('d')),
      }))
      .finish((_ctx, { members }) => members)
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
        container: createTestContainer(),
        workflows: [implementation],
        workerId: `coordinator-${round}`,
      })
      await runActivityWorker({
        ...runtime,
        container: createTestContainer(),
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
    expect(snapshot?.run.output).toStrictEqual({
      a: { text: 'a:alpha' },
      b: { text: 'b:alpha' },
      c: { text: 'c:alpha' },
      d: { text: 'd:alpha' },
    })

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
      input: t.object({ scenario: t.string() }),
    })
      .activity('step', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .step(async (_ctx, input) => ({ text: `step:${input.scenario}` }))
      .finish((_ctx, { step }) => step)
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
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-status',
    })
    expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
      'running',
    )

    await runActivityWorker({
      ...runtime,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'activity-status',
    })
    await runWorkflowWorker({
      ...runtime,
      container: createTestContainer(),
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
      input: t.object({ scenario: t.string() }),
    })
      .activity('inner', { input: memberInput, output: memberOutput })
      .build()
    const parentWorkflow = defineWorkflow({
      name: 'fanout.waiting-parent',
      input: t.object({ scenario: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()

    const childImplementation = implementWorkflow(childWorkflow)
      .inner(async (_ctx, input) => ({ text: `inner:${input.scenario}` }))
      .finish((_ctx, { inner }) => inner)
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow)
      .finish((_ctx, { child }) => child)
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
      container: createTestContainer(),
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
      input: t.object({ scenario: t.string() }),
    })
      .activity('step', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    const implementation = implementWorkflow(declaredWorkflow)
      .step(async (_ctx, input) => ({ text: `step:${input.scenario}` }))
      .finish((_ctx, { step }) => step)

    // Same workflow name, drifted definition: the node's activity was renamed
    // in the deployed worker, so the dispatched command can never resolve.
    const driftedWorkflow = defineWorkflow({
      name: 'fanout.unroutable',
      input: t.object({ scenario: t.string() }),
    })
      .activity('stepRenamed', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    const driftedImplementation = implementWorkflow(driftedWorkflow)
      .stepRenamed(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, outputs) => outputs)

    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow: declaredWorkflow,
      input: { scenario: 'omega' },
    })
    await runWorkflowWorker({
      ...runtime,
      container: createTestContainer(),
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
    await runActivityWorker({
      ...runtime,
      container: createTestContainer(),
      workflows: [driftedImplementation],
      activityNames: [command!.activityName],
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
      runCoordinationExecutor: runtime.runCoordinationExecutor,
    })
    expect(reaped).toBe(1)
    await runWorkflowWorker({
      ...runtime,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-reap',
      reaping: false,
      runTimeouts: false,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('failed')
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.children[0]?.status).toBe('failed')

    // Reaped commands are claimed exactly once.
    const again = await reapDeadWorkflowCommands({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
    })
    expect(again.reaped).toBe(0)
  })

  it('fails runs that exceed their definition timeout', async () => {
    const workflow = defineWorkflow({
      name: 'fanout.run-timeout',
      input: t.object({ scenario: t.string() }),
      timeout: '30ms',
    })
      .activity('step', {
        input: memberInput,
        output: memberOutput,
      })
      .build()
    // No activity worker ever runs, so without the sweep this run would sit
    // in running forever.
    const implementation = implementWorkflow(workflow)
      .step(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { step }) => step)
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow,
      input: { scenario: 'late' },
    })
    await runWorkflowWorker({
      ...runtime,
      container: createTestContainer(),
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
