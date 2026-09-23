import { afterEach, describe, expect, it, test, vi } from 'vitest'
import * as z from 'zod'

import {
  createInMemoryWorkflowRuntime,
  type InMemoryWorkflowRuntime,
} from '../src/adapters/in-memory.ts'
import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementWorkflow,
} from '../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'
import { reapDeadWorkflowCommands } from '../src/runtime/worker.ts'
import { defineClaimFencingTests } from './support/fencing.ts'

const workflow = defineWorkflow({
  name: 'isolated-workflow',
  input: z.string(),
  output: z.string(),
  idempotency: () => ['shared-key'],
})
  .activity('echo', { input: z.string(), output: z.string() })
  .build()

const implementation = implementWorkflow(workflow, { pool: 'test' })
  .echo(async (input) => input, {
    input: (_outputs, input) => input,
  })
  .finish(({ echo }) => echo)

async function drain(runtime: InMemoryWorkflowRuntime) {
  const worker = {
    ...runtime,
    env: undefined,
    workflows: [implementation],
    tasks: [],
    workerId: 'shared-worker',
  }

  await runWorkflowWorker(worker)
  await runExecutionWorker(worker)
  await runWorkflowWorker(worker)
}

describe('in-memory runtime isolation', () => {
  it.each(['active', 'all'] as const)(
    'runs independent workflows with overlapping IDs and %s unique keys',
    async (scope) => {
      const left = createInMemoryWorkflowRuntime()
      const right = createInMemoryWorkflowRuntime()
      const options = { unique: { key: ['shared-key'], scope } }
      const [leftRun, rightRun] = await Promise.all([
        createWorkflowRuntimeClient(left).start(workflow, 'left', options),
        createWorkflowRuntimeClient(right).start(workflow, 'right', options),
      ])

      // Identical IDs and keys must still address different adapter state.
      expect(leftRun.id).toBe(rightRun.id)
      await Promise.all([drain(left), drain(right)])

      for (const [runtime, output] of [
        [left, 'left'],
        [right, 'right'],
      ] as const) {
        const snapshot = await runtime.store.loadRunSnapshot(leftRun.id)
        expect(snapshot).toMatchObject({
          run: { status: 'completed', input: output, output },
          nodes: [{ name: 'echo', status: 'completed', output }],
          children: [{ nodeName: 'echo', status: 'completed', output }],
          attempts: [{ status: 'completed', input: output, output }],
        })
        expect(runtime.inspect().continueRunCommands).toEqual([])
        expect(runtime.inspect().activityCommands).toEqual([])
      }

      await left.store.deleteRun(leftRun.id)
      expect(left.inspect().runs).toEqual([])
      expect(right.inspect().runs).toHaveLength(1)
      expect(right.inspect().attempts).toHaveLength(1)
    },
  )

  it('keeps run leases, command claims, and delivery limits per adapter', async () => {
    const left = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const right = createInMemoryWorkflowRuntime({ maxDeliveries: 2 })
    const run = { workflowName: workflow.name, input: 'shared' }
    const [leftRun, rightRun] = await Promise.all([
      left.atomicStart.startWorkflowRun({ run }),
      right.atomicStart.startWorkflowRun({ run }),
    ])
    const [leftLease, rightLease] = await Promise.all([
      left.store.acquireRunLease({ runId: leftRun.id, leaseMs: 30_000 }),
      right.store.acquireRunLease({ runId: rightRun.id, leaseMs: 30_000 }),
    ])
    expect(leftLease).toBeDefined()
    expect(rightLease).toBeDefined()
    await left.store.releaseRunLease(leftLease!)
    await expect(
      right.store.acquireRunLease({ runId: rightRun.id, leaseMs: 30_000 }),
    ).resolves.toBeUndefined()

    const worker = {
      workerId: 'shared-worker',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    }
    const [leftClaim, rightClaim] = await Promise.all([
      left.runCoordinationExecutor.claim(worker),
      right.runCoordinationExecutor.claim(worker),
    ])
    expect(leftClaim).not.toBeNull()
    expect(rightClaim).not.toBeNull()
    const error = new Error('delivery failed')
    await left.runCoordinationExecutor.release(leftClaim!, { error })
    await right.runCoordinationExecutor.release(rightClaim!, { error })

    await expect(left.store.listDeadCommands()).resolves.toHaveLength(1)
    await expect(right.store.listDeadCommands()).resolves.toEqual([])
    await left.store.requeueDeadCommand(leftClaim!.id)
    expect(right.inspect().continueRunCommands[0]?.runAt).toEqual(
      expect.any(Number),
    )
  })

  it('isolates schedules and wake listeners, including disposal', async () => {
    const left = createInMemoryWorkflowRuntime()
    const right = createInMemoryWorkflowRuntime()
    for (const [runtime, input] of [
      [left, 'left'],
      [right, 'right'],
    ] as const) {
      await runtime.scheduler.reconcile([
        defineSchedule({
          name: 'shared-schedule',
          runnable: workflow,
          input,
          every: '1m',
        }),
      ])
    }

    const leftCommand = vi.fn()
    const rightCommand = vi.fn()
    left.wakeEvents.onCommand('continue', leftCommand)
    right.wakeEvents.onCommand('continue', rightCommand)
    const leftRun = await left.scheduler.trigger('shared-schedule')
    expect(leftCommand).toHaveBeenCalledTimes(1)
    expect(rightCommand).not.toHaveBeenCalled()
    expect(right.inspect().runs).toEqual([])

    const rightRun = await right.scheduler.trigger('shared-schedule')
    expect(rightRun.id).toBe(leftRun.id)
    expect(rightRun.input).toBe('right')
    const leftEvent = vi.fn()
    const rightEvent = vi.fn()
    const leftCancellation = vi.fn()
    const rightCancellation = vi.fn()
    left.wakeEvents.onRunEvent!(leftRun.id, leftEvent)
    right.wakeEvents.onRunEvent!(rightRun.id, rightEvent)
    left.wakeEvents.onCancellation(leftRun.id, leftCancellation)
    right.wakeEvents.onCancellation(rightRun.id, rightCancellation)

    await left.store.requestRunCancellation({ runId: leftRun.id })
    expect(leftEvent).toHaveBeenCalledTimes(1)
    expect(leftCancellation).toHaveBeenCalledTimes(1)
    expect(rightEvent).not.toHaveBeenCalled()
    expect(rightCancellation).not.toHaveBeenCalled()

    await left.wakeEvents.dispose?.()
    await right.store.requestRunCancellation({ runId: rightRun.id })
    await right.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: rightRun.id,
      workflowName: workflow.name,
    })
    expect(rightEvent).toHaveBeenCalledTimes(1)
    expect(rightCancellation).toHaveBeenCalledTimes(1)
    expect(rightCommand).toHaveBeenCalledTimes(2)
    expect(leftEvent).toHaveBeenCalledTimes(1)
    expect(leftCommand).toHaveBeenCalledTimes(1)

    await left.scheduler.setEnabled('shared-schedule', false)
    await left.scheduler.reconcile([])
    await expect(left.scheduler.list()).resolves.toEqual([])
    await expect(right.scheduler.list()).resolves.toMatchObject([
      { name: 'shared-schedule', enabled: true, input: 'right' },
    ])
  })
})

describe('in-memory adapter', () => {
  const io = { input: z.object({}), output: z.object({}) }
  const workflow = defineWorkflow({
    name: 'in-memory.adapter',
    ...io,
  }).build()
  const task = defineTask({ name: 'in-memory.adapter-task', ...io })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a manual retry when an unrelated attempt command is dead', async () => {
    const runtime = createInMemoryWorkflowRuntime({ maxDeliveries: 1 })
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, {})
    const continuation = await runtime.runCoordinationExecutor.claim({
      workflowNames: [workflow.name],
      workerId: 'coordinator',
      leaseMs: 30_000,
    })
    await runtime.runCoordinationExecutor.release(continuation!, {
      error: new Error('dead'),
    })
    const staleBatch = await runtime.store.listUnreapedDeadCommands()
    expect(staleBatch).toHaveLength(1)
    await reapDeadWorkflowCommands(runtime)
    await client.retry(run.id)
    const retried = await client.get(run.id)
    expect(retried?.run.status).not.toBe('failed')

    await client.start(task, {})
    const attempt = await runtime.attemptExecutor.claim({
      workflowNames: [],
      taskNames: [task.name],
      workerId: 'execution',
      leaseMs: 30_000,
    })
    await runtime.attemptExecutor.release(attempt!, {
      error: new Error('dead'),
    })
    await expect(
      runtime.store.listUnreapedDeadCommands({ commandId: staleBatch[0]!.id }),
    ).resolves.toStrictEqual([])
    await expect(
      runtime.store.listUnreapedDeadCommands({ commandId: attempt!.id }),
    ).resolves.toMatchObject([{ id: attempt!.id, kind: 'task' }])

    // The reaper listed the continuation before the retry retired it.
    await reapDeadWorkflowCommands({
      ...runtime,
      store: {
        ...runtime.store,
        listUnreapedDeadCommands: (params) =>
          params?.commandId
            ? runtime.store.listUnreapedDeadCommands(params)
            : Promise.resolve(staleBatch),
      },
    })
    expect(await client.get(run.id)).toEqual(retried)
  })

  it('does not advance delays or leases with the number of operations', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const worker = {
      workflowNames: [workflow.name],
      workerId: 'coordinator',
      leaseMs: 100,
    }

    const leased = await client.start(workflow, {})
    const claimed = await runtime.runCoordinationExecutor.claim(worker)
    expect(claimed?.command.runId).toBe(leased.id)
    const delayed = await runtime.store.createRun({
      workflowName: workflow.name,
      input: {},
    })
    await runtime.runCoordinationExecutor.enqueueDelayed(
      { kind: 'continueRun', runId: delayed.id, workflowName: workflow.name },
      Date.now() + 100,
    )

    for (let index = 0; index < 150; index += 1)
      await runtime.store.createRun({ workflowName: 'unrelated', input: {} })

    // Neither the delay nor the lease has elapsed: no wall time has passed.
    expect(await runtime.runCoordinationExecutor.claim(worker)).toBeNull()
    vi.setSystemTime(Date.now() + 100)
    const due = [
      await runtime.runCoordinationExecutor.claim(worker),
      await runtime.runCoordinationExecutor.claim(worker),
    ]
    expect(new Set(due.map((command) => command?.command.runId))).toStrictEqual(
      new Set([leased.id, delayed.id]),
    )
  })

  it('orders records created within one millisecond by creation', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const created: string[] = []
    for (let index = 0; index < 12; index += 1)
      created.push((await client.start(task, {})).id)

    const listed = await client.list({ limit: 5 })
    expect(listed.runs.map((run) => run.id)).toStrictEqual(
      created.toReversed().slice(0, 5),
    )
    const next = await client.list({ limit: 5, cursor: listed.nextCursor })
    expect(next.runs.map((run) => run.id)).toStrictEqual(
      created.toReversed().slice(5, 10),
    )

    const claimedRunIds: string[] = []
    for (let index = 0; index < created.length; index += 1) {
      const attempt = await runtime.attemptExecutor.claim({
        workflowNames: [],
        taskNames: [task.name],
        workerId: 'execution',
        leaseMs: 30_000,
      })
      claimedRunIds.push(attempt!.command.runId)
    }
    expect(claimedRunIds).toStrictEqual(created)
  })
})

describe('in-memory createAttempt after a predecessor', () => {
  async function createChild() {
    const runtime = createInMemoryWorkflowRuntime()
    const { store } = runtime
    const run = await store.createRun({
      workflowName: 'attempt.after-predecessor',
      input: {},
    })
    const ref = { runId: run.id, nodeName: 'work', childKey: '$self' }
    await store.createNode({ runId: run.id, name: 'work', kind: 'activity' })
    await store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'work',
      children: [{ childKey: '$self', kind: 'activity' }],
    })
    const child = async () =>
      (await store.loadNodeSnapshot(ref))!.children.find(
        (candidate) => candidate.childKey === '$self',
      )!
    return { store, ref, child }
  }

  it('shares one successor between two retries of the same failed attempt', async () => {
    const { store, ref, child } = await createChild()
    const first = await store.createAttempt({ ...ref, input: {} })
    await store.failCurrentAttempt({
      attemptId: first.id,
      leaseToken: first.leaseToken!,
      error: new Error('failed'),
    })

    // `after` is still current: the retry is created.
    const retry = await store.createAttempt({
      ...ref,
      input: {},
      after: first.id,
    })
    expect(retry.id).not.toBe(first.id)
    expect(retry.retryAttemptNumber).toBe(2)

    // A worker that lost the claim replays the same retry.
    const replayed = await store.createAttempt({
      ...ref,
      input: {},
      after: first.id,
    })
    expect(replayed).toStrictEqual(retry)
    expect(await child()).toMatchObject({
      currentAttemptId: retry.id,
      attemptCount: 2,
    })
    expect((await store.loadNodeSnapshot(ref))!.attempts).toHaveLength(2)
  })

  it('returns a successor that already settled the child', async () => {
    const { store, ref, child } = await createChild()
    const first = await store.createAttempt({ ...ref, input: {} })
    const retry = await store.createAttempt({
      ...ref,
      input: {},
      after: first.id,
    })
    const completed = await store.completeCurrentAttempt({
      attemptId: retry.id,
      leaseToken: retry.leaseToken!,
      output: {},
    })

    await expect(
      store.createAttempt({ ...ref, input: {}, after: first.id }),
    ).resolves.toStrictEqual(completed)
    expect(await child()).toMatchObject({ attemptCount: 2 })
  })

  it('creates unconditionally without `after`', async () => {
    const { store, ref, child } = await createChild()
    const first = await store.createAttempt({ ...ref, input: {} })
    const second = await store.createAttempt({ ...ref, input: {} })
    expect(second.id).not.toBe(first.id)
    expect(await child()).toMatchObject({
      currentAttemptId: second.id,
      attemptCount: 2,
    })
  })
})

describe('in-memory retention', () => {
  const text = z.string()
  const child = defineWorkflow({
    name: 'retention.detached-child',
    input: text,
    output: text,
  })
    .activity('work', { input: text, output: text })
    .build()
  const childImplementation = implementWorkflow(child, { pool: 'test' })
    .work(async (input) => `${input}!`)
    .finish(({ work }) => work)
  const parent = defineWorkflow({
    name: 'retention.detaching-parent',
    input: text,
    output: text,
  })
    .workflow('sub', child, { cancellation: 'detach' })
    .build()
  const parentImplementation = implementWorkflow(parent, { pool: 'test' })
    .sub(child)
    .finish(() => 'done')

  it('keeps a family whose detached child is still running', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [parentImplementation, childImplementation],
      tasks: [],
      workerId: 'retention',
    }
    const run = await client.start(parent, 'hi')
    // Parks the parent on its child; the child stays live on its unclaimed activity.
    await runWorkflowWorker(workers)
    const childRunId = (await client.get(run.id))!.children[0]!.childRunId!
    await client.cancel(run.id)
    await runWorkflowWorker(workers)
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect((await client.get(childRunId))!.run.status).toBe('running')

    const prune = () =>
      runtime.store.pruneTerminalRuns({
        olderThan: Number.MAX_SAFE_INTEGER,
      })
    expect(await prune()).toStrictEqual({ deleted: 0 })
    expect((await client.get(run.id))!.run.status).toBe('cancelled')
    expect((await client.get(childRunId))!.run.status).toBe('running')
    expect(runtime.inspect().activityCommands).toHaveLength(1)

    for (let round = 0; round < 4; round++) {
      await runWorkflowWorker(workers)
      await runExecutionWorker(workers)
    }
    expect((await client.get(childRunId))!.run.status).toBe('completed')

    expect(await prune()).toStrictEqual({ deleted: 1 })
    expect(await client.get(run.id)).toBeUndefined()
    expect(await client.get(childRunId)).toBeUndefined()
  })

  it('keeps a terminal parent whose child run carries a foreign root id', async () => {
    const { store } = createInMemoryWorkflowRuntime()
    const parent = await store.createRun({
      workflowName: 'retention.parent',
      input: null,
    })
    const elsewhere = await store.createRun({
      workflowName: 'retention.elsewhere',
      input: null,
    })
    // A child normally inherits its parent's root; an explicit foreign root
    // still hangs off the parent, and deletion follows that link.
    const child = await store.createRun({
      workflowName: 'retention.child',
      input: null,
      parentRunId: parent.id,
      parentNodeName: 'sub',
      rootRunId: elsewhere.id,
    })
    expect(child.rootRunId).toBe(elsewhere.id)
    await store.completeRun({ runId: parent.id, output: null })

    const olderThan = Date.now() + 60_000
    expect(await store.pruneTerminalRuns({ olderThan })).toStrictEqual({
      deleted: 0,
    })
    expect(await store.loadRuns([parent.id, child.id])).toHaveLength(2)
    await expect(store.deleteRun(parent.id)).rejects.toThrow(
      'has non-terminal runs',
    )

    await store.completeRun({ runId: child.id, output: null })
    expect(await store.pruneTerminalRuns({ olderThan })).toStrictEqual({
      deleted: 1,
    })
    expect(await store.loadRuns([parent.id, child.id])).toHaveLength(0)
  })
})

describe('in-memory root inheritance', () => {
  test('still roots a run in itself when its parent does not exist', async () => {
    const { store } = createInMemoryWorkflowRuntime()

    const orphan = await store.createRun({
      workflowName: 'orphan',
      input: {},
      parentRunId: 'missing-parent',
    })

    expect(orphan).toMatchObject({
      parentRunId: 'missing-parent',
      rootRunId: orphan.id,
    })
  })
})

describe('in-memory schedule fire', () => {
  const text = z.string()

  it('keeps a disable that lands while the fire creates its run', async () => {
    const workflow = defineWorkflow({
      name: 'schedule-fire.workflow',
      input: text,
      output: text,
    }).build()
    const schedule = defineSchedule({
      name: 'schedule-fire',
      runnable: workflow,
      input: 'x',
      every: '10ms',
      immediately: true,
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const scheduler = runtime.scheduler!
    await scheduler.reconcile([schedule])
    const [before] = await scheduler.list()
    const now = before!.nextRunAt + 1_000

    // The fire is suspended on its run creation when the disable lands.
    const firing = scheduler.fireDue({ now })
    const disabled = await scheduler.setEnabled(schedule.name, false)
    expect(disabled.enabled).toBe(false)
    await expect(firing).resolves.toStrictEqual({ fired: 1 })

    const [after] = await scheduler.list()
    expect(after).toMatchObject({
      enabled: false,
      lastSlotAt: before!.nextRunAt,
    })
    expect(after!.nextRunAt).toBeGreaterThan(now)
    await expect(
      scheduler.fireDue({ now: after!.nextRunAt + 1_000 }),
    ).resolves.toStrictEqual({ fired: 0 })
    const { runs } = await client.list({ tags: { schedule: schedule.name } })
    expect(runs).toHaveLength(1)
  })

  it('does not restore a schedule a reconcile removed during the fire', async () => {
    const workflow = defineWorkflow({
      name: 'schedule-fire.removed.workflow',
      input: text,
      output: text,
    }).build()
    const schedule = defineSchedule({
      name: 'schedule-fire.removed',
      runnable: workflow,
      input: 'x',
      every: '10ms',
      immediately: true,
    })
    const runtime = createInMemoryWorkflowRuntime()
    const scheduler = runtime.scheduler!
    await scheduler.reconcile([schedule])
    const [before] = await scheduler.list()

    const firing = scheduler.fireDue({ now: before!.nextRunAt + 1_000 })
    await scheduler.reconcile([])
    await firing

    expect(await scheduler.list()).toStrictEqual([])
  })
})

describe('in-memory settlement fencing by the queue claim', () => {
  defineClaimFencingTests((options) => createInMemoryWorkflowRuntime(options))
})
