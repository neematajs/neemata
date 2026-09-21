import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import {
  createInMemoryWorkflowRuntime,
  type InMemoryWorkflowRuntime,
} from '../src/adapters/in-memory.ts'
import {
  defineSchedule,
  defineWorkflow,
  implementWorkflow,
} from '../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

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
    expect(right.inspect().continueRunCommands[0]?.runAt).toBeInstanceOf(Date)
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
