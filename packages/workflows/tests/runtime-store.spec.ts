import { describe, expect, it } from 'vitest'

import { createInMemoryWorkflowRuntime } from '../src/testing/index.ts'

describe('in-memory workflow store', () => {
  it('creates runs, leases one coordinator at a time, and releases leases', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    const firstLease = await runtime.store.acquireRunLease({
      runId: run.id,
      workerId: 'worker-1',
      leaseMs: 30_000,
    })
    const secondLease = await runtime.store.acquireRunLease({
      runId: run.id,
      workerId: 'worker-2',
      leaseMs: 30_000,
    })

    expect(run.status).toBe('queued')
    expect(run.rootRunId).toBe(run.id)
    expect(firstLease).toBeDefined()
    expect(secondLease).toBeUndefined()

    await runtime.store.releaseRunLease(firstLease!)

    const thirdLease = await runtime.store.acquireRunLease({
      runId: run.id,
      workerId: 'worker-2',
      leaseMs: 30_000,
    })

    expect(thirdLease).toBeDefined()
  })

  it('persists node input before attempts and ignores stale completions', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    const sameNode = await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    await runtime.store.setNodeInput({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })
    const firstAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })
    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })

    const stale = await runtime.store.completeCurrentAttempt({
      attemptId: firstAttempt.id,
      leaseToken: firstAttempt.leaseToken!,
      output: { text: 'stale' },
    })
    const wrongToken = await runtime.store.completeCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: firstAttempt.leaseToken!,
      output: { text: 'wrong token' },
    })
    const fresh = await runtime.store.completeCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: secondAttempt.leaseToken!,
      output: { text: 'fresh' },
    })

    expect(sameNode.attemptCount).toBe(0)
    expect(firstAttempt.status).toBe('started')
    expect(firstAttempt.leaseToken).toEqual(expect.any(String))
    expect(secondAttempt.attemptNumber).toBe(2)
    expect(stale).toBeUndefined()
    expect(wrongToken).toBeUndefined()
    expect(fresh?.output).toStrictEqual({ text: 'fresh' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes).toHaveLength(1)
    expect(snapshot?.nodes[0]?.input).toStrictEqual({ scenario: 'a' })
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.nodes[0]?.currentAttemptId).toBe(secondAttempt.id)
    expect(snapshot?.nodes[0]?.attemptCount).toBe(2)
    expect(snapshot?.attempts).toHaveLength(2)
    expect(snapshot?.childLinks).toStrictEqual([])
    expect(snapshot?.mapItems).toStrictEqual([])
  })

  it('ignores stale failures and updates current attempt, node, and run state', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    const firstAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })
    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'a' },
    })

    const stale = await runtime.store.failCurrentAttempt({
      attemptId: firstAttempt.id,
      leaseToken: firstAttempt.leaseToken!,
      error: new Error('stale'),
    })
    const wrongToken = await runtime.store.failCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: firstAttempt.leaseToken!,
      error: new Error('wrong token'),
    })
    const fresh = await runtime.store.failCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: secondAttempt.leaseToken!,
      error: new Error('fresh'),
    })
    const completedNode = await runtime.store.completeNode({
      runId: run.id,
      nodeName: 'content',
      output: { text: 'done' },
    })
    const failedNode = await runtime.store.failNode({
      runId: run.id,
      nodeName: 'content',
      error: 'node failed',
    })
    const completedRun = await runtime.store.completeRun({
      runId: run.id,
      output: { ok: true },
    })
    const failedRun = await runtime.store.failRun({
      runId: run.id,
      error: 'run failed',
    })

    expect(stale).toBeUndefined()
    expect(wrongToken).toBeUndefined()
    expect(fresh?.status).toBe('failed')
    expect(fresh?.error?.message).toBe('fresh')
    expect(completedNode?.status).toBe('completed')
    expect(completedNode?.output).toStrictEqual({ text: 'done' })
    expect(failedNode?.status).toBe('failed')
    expect(failedNode?.error?.message).toBe('node failed')
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.output).toStrictEqual({ ok: true })
    expect(failedRun?.status).toBe('failed')
    expect(failedRun?.error?.message).toBe('run failed')
  })

  it('queues, claims, acknowledges, and releases run and attempt commands', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const continueCommand = {
      kind: 'continueRun' as const,
      runId: 'run-1',
      workflowName: 'case-generation',
    }
    const activityCommand = {
      kind: 'activityAttempt' as const,
      workflowName: 'case-generation',
      activityName: 'writeContent',
      runId: 'run-1',
      nodeName: 'content',
      attemptId: 'attempt-1',
      leaseToken: 'activity-lease',
      input: { scenario: 'a' },
    }
    const taskCommand = {
      kind: 'taskAttempt' as const,
      workflowName: 'case-generation',
      taskName: 'writeContent',
      runId: 'run-1',
      nodeName: 'content',
      attemptId: 'attempt-2',
      leaseToken: 'task-lease',
      input: { scenario: 'a' },
    }

    await runtime.runCoordinationExecutor.enqueueDelayed(
      { ...continueCommand, runId: 'run-2' },
      new Date(Date.now() + 3_600_000),
    )
    await runtime.runCoordinationExecutor.enqueue(continueCommand)
    await runtime.runCoordinationExecutor.enqueueDelayed(
      { ...continueCommand, runId: 'run-3' },
      new Date(Date.now() - 1_000),
    )
    const claimedRun = await runtime.runCoordinationExecutor.claim({
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      leaseMs: 30_000,
    })
    expect(claimedRun?.command).toStrictEqual(continueCommand)
    expect(runtime.inspect().continueRunCommands).toHaveLength(2)

    await runtime.runCoordinationExecutor.release(claimedRun!)
    await runtime.runCoordinationExecutor.release(claimedRun!)
    expect(runtime.inspect().continueRunCommands).toHaveLength(3)

    const releasedRun = await runtime.runCoordinationExecutor.claim({
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      leaseMs: 30_000,
    })
    expect(releasedRun?.command.runId).toBe('run-3')
    await runtime.runCoordinationExecutor.ack(releasedRun!)
    await runtime.runCoordinationExecutor.release(releasedRun!)
    expect(runtime.inspect().continueRunCommands).toHaveLength(2)

    const requeuedRun = await runtime.runCoordinationExecutor.claim({
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      leaseMs: 30_000,
    })
    expect(requeuedRun?.command.runId).toBe('run-1')
    await runtime.runCoordinationExecutor.ack(requeuedRun!)

    await runtime.attemptExecutor.dispatchActivity(activityCommand)
    await runtime.attemptExecutor.dispatchTask(taskCommand)
    expect(runtime.inspect().taskCommands).toHaveLength(1)

    const claimedActivity = await runtime.attemptExecutor.claimActivity({
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      activityNames: ['writeContent'],
      leaseMs: 30_000,
    })
    const claimedTask = await runtime.attemptExecutor.claimTask({
      workerId: 'worker-1',
      taskNames: ['writeContent'],
      leaseMs: 30_000,
    })

    expect(claimedActivity?.leaseToken).toBe('activity-lease')
    expect(claimedActivity?.leaseToken).not.toBe(activityCommand.attemptId)
    expect(claimedTask?.leaseToken).toBe('task-lease')
    expect(claimedTask?.leaseToken).not.toBe(taskCommand.attemptId)

    await runtime.attemptExecutor.heartbeat(claimedActivity!)
    await runtime.attemptExecutor.release(claimedActivity!)
    await runtime.attemptExecutor.release(claimedActivity!)
    expect(runtime.inspect().activityCommands).toHaveLength(1)

    const releasedActivity = await runtime.attemptExecutor.claimActivity({
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      leaseMs: 30_000,
    })
    await runtime.attemptExecutor.ack(releasedActivity!)
    await runtime.attemptExecutor.release(releasedActivity!)
    await runtime.attemptExecutor.ack(claimedTask!)
    await runtime.attemptExecutor.release(claimedTask!)

    expect(runtime.inspect().activityCommands).toHaveLength(0)
    expect(runtime.inspect().taskCommands).toHaveLength(0)
  })
})
