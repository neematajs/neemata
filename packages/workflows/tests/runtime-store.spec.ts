import { describe, expect, it } from 'vitest'

import { createInMemoryWorkflowRuntime } from '../src/runtime/index.ts'

const waitForReleaseBackoff = () =>
  new Promise((resolve) => setTimeout(resolve, 60))

describe('in-memory workflow store', () => {
  it('creates runs, leases one coordinator at a time, and releases leases', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    const firstLease = await runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 30_000,
    })
    const secondLease = await runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 30_000,
    })

    expect(run.status).toBe('queued')
    expect(run.rootRunId).toBe(run.id)
    expect(firstLease).toBeDefined()
    expect(secondLease).toBeUndefined()

    await runtime.store.releaseRunLease(firstLease!)

    const thirdLease = await runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 30_000,
    })

    expect(thirdLease).toBeDefined()
  })

  it('allows a new coordinator to acquire an expired run lease', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    const expiredLease = await runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 0,
    })
    const nextLease = await runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 30_000,
    })

    expect(expiredLease).toBeDefined()
    expect(nextLease).toBeDefined()
    expect(nextLease?.leaseToken).not.toBe(expiredLease?.leaseToken)
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
    const completedAgain = await runtime.store.completeCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: secondAttempt.leaseToken!,
      output: { text: 'double complete' },
    })
    const failedAfterComplete = await runtime.store.failCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: secondAttempt.leaseToken!,
      error: new Error('double fail'),
    })

    expect(sameNode.attemptCount).toBe(0)
    expect(firstAttempt.status).toBe('started')
    expect(firstAttempt.leaseToken).toEqual(expect.any(String))
    expect(secondAttempt.attemptNumber).toBe(2)
    expect(stale).toBeUndefined()
    expect(wrongToken).toBeUndefined()
    expect(fresh?.output).toStrictEqual({ text: 'fresh' })
    expect(completedAgain).toBeUndefined()
    expect(failedAfterComplete).toBeUndefined()

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes).toHaveLength(1)
    expect(snapshot?.nodes[0]?.input).toStrictEqual({ scenario: 'a' })
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.nodes[0]?.currentAttemptId).toBe(secondAttempt.id)
    expect(snapshot?.nodes[0]?.attemptCount).toBe(2)
    expect(snapshot?.attempts).toHaveLength(2)
    expect(snapshot?.attempts[1]?.output).toStrictEqual({ text: 'fresh' })
    expect(snapshot?.childLinks).toStrictEqual([])
    expect(snapshot?.mapItems).toStrictEqual([])
  })

  it('ignores stale failures and treats terminal node and run updates as no-ops', async () => {
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
    expect(failedNode?.status).toBe('completed')
    expect(failedNode?.output).toStrictEqual({ text: 'done' })
    expect(completedRun?.status).toBe('completed')
    expect(completedRun?.output).toStrictEqual({ ok: true })
    expect(failedRun?.status).toBe('completed')
    expect(failedRun?.output).toStrictEqual({ ok: true })
  })

  it('requires an existing parent node before ensuring a node attempt', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    await expect(
      runtime.store.ensureNodeAttempt({
        identity: { runId: run.id, nodeName: 'content' },
        kind: 'activity',
        input: { scenario: 'a' },
      }),
    ).rejects.toThrow(`Missing node [${run.id}.content]`)
  })

  it('ensures node attempts idempotently by structured identity', async () => {
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
    const identity = {
      runId: run.id,
      nodeName: 'content',
      caseKey: 'case-a',
      memberKey: 'member-a',
    }

    const first = await runtime.store.ensureNodeAttempt({
      identity,
      kind: 'activity',
      input: { scenario: 'a' },
    })
    const second = await runtime.store.ensureNodeAttempt({
      identity,
      kind: 'activity',
      input: { scenario: 'a' },
    })
    const snapshot = await runtime.store.loadRunSnapshot(run.id)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.attempt.id).toBe(first.attempt.id)
    expect(first.attempt.identity).toStrictEqual(identity)
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
  })

  it('rejects primitive node attempt kind mismatches', async () => {
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

    await expect(
      runtime.store.ensureNodeAttempt({
        identity: { runId: run.id, nodeName: 'content' },
        kind: 'task',
        input: { scenario: 'a' },
      }),
    ).rejects.toThrow(
      `Node [${run.id}.content] kind [activity] cannot create [task] attempt`,
    )
  })

  it('rejects reused semantic attempt identities with primitive kind mismatches', async () => {
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
    const identity = { runId: run.id, nodeName: 'content' }

    await runtime.store.ensureNodeAttempt({
      identity,
      kind: 'activity',
      input: { scenario: 'a' },
    })

    await expect(
      runtime.store.ensureNodeAttempt({
        identity,
        kind: 'task',
        input: { scenario: 'a' },
      }),
    ).rejects.toThrow(
      `Node [${run.id}.content] kind [activity] cannot create [task] attempt`,
    )
  })

  it('persists selected node case idempotently', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'branch-workflow',
      input: {},
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'choice',
      kind: 'branch',
    })

    const first = await runtime.store.selectNodeCase({
      runId: run.id,
      nodeName: 'choice',
      caseKey: 'normal',
    })
    const second = await runtime.store.selectNodeCase({
      runId: run.id,
      nodeName: 'choice',
      caseKey: 'normal',
    })

    expect(first?.selectedCase).toBe('normal')
    expect(second?.selectedCase).toBe('normal')
    expect(second?.version).toBe(first?.version)
    expect(second?.updatedAt).toBe(first?.updatedAt)
  })

  it('rejects conflicting selected node case', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'branch-workflow',
      input: {},
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'choice',
      kind: 'branch',
    })
    await runtime.store.selectNodeCase({
      runId: run.id,
      nodeName: 'choice',
      caseKey: 'normal',
    })

    await expect(
      runtime.store.selectNodeCase({
        runId: run.id,
        nodeName: 'choice',
        caseKey: 'fallback',
      }),
    ).rejects.toThrow('Conflicting selected case')
  })

  it('waits a node idempotently', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })
    const node = await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })

    const firstWait = await runtime.store.waitNode({
      runId: run.id,
      nodeName: 'content',
    })
    const secondWait = await runtime.store.waitNode({
      runId: run.id,
      nodeName: 'content',
    })

    expect(node.status).toBe('pending')
    expect(firstWait?.status).toBe('waiting')
    expect(firstWait?.version).toBe(node.version + 1)
    expect(secondWait?.status).toBe('waiting')
    expect(secondWait?.version).toBe(firstWait?.version)
    expect(secondWait?.updatedAt).toBe(firstWait?.updatedAt)
  })

  it('ensures child workflow runs idempotently by identity', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'parent',
      input: { scenario: 'a' },
    })
    const params = {
      identity: { runId: run.id, nodeName: 'child', memberKey: 'a' },
      workflowName: 'child',
      input: { scenario: 'a' },
      parentRunId: run.id,
      parentNodeName: 'child',
      rootRunId: run.rootRunId,
    }

    const first = await runtime.store.ensureChildWorkflowRun(params)
    const second = await runtime.store.ensureChildWorkflowRun(params)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.childRun).toBe(first.childRun)
    expect(second.childLink).toBe(first.childLink)
    expect(first.childRun.parentRunId).toBe(run.id)
    expect(first.childRun.rootRunId).toBe(run.rootRunId)
  })

  it('rejects child workflow identities that do not match the parent node', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'parent',
      input: { scenario: 'a' },
    })

    await expect(
      runtime.store.ensureChildWorkflowRun({
        identity: { runId: run.id, nodeName: 'other' },
        workflowName: 'child',
        input: { scenario: 'a' },
        parentRunId: run.id,
        parentNodeName: 'child',
        rootRunId: run.rootRunId,
      }),
    ).rejects.toThrow(
      `Child identity does not match parent node [${run.id}.child]`,
    )
  })

  it('ensures map items once and rejects conflicting shapes', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    const first = await runtime.store.ensureMapItems({
      runId: run.id,
      nodeName: 'items',
      items: [{ id: 1 }, { id: 2 }],
      keys: ['one', 'two'],
    })
    const same = await runtime.store.ensureMapItems({
      runId: run.id,
      nodeName: 'items',
      items: [{ id: 1 }, { id: 2 }],
      keys: ['one', 'two'],
    })

    expect(first.created).toBe(true)
    expect(same.created).toBe(false)
    expect(same.items).toStrictEqual(first.items)
    await expect(
      runtime.store.ensureMapItems({
        runId: run.id,
        nodeName: 'items',
        items: [{ id: 1 }],
        keys: ['one'],
      }),
    ).rejects.toThrow('Conflicting map items for [')
    await expect(
      runtime.store.ensureMapItems({
        runId: run.id,
        nodeName: 'items',
        items: [{ id: 1 }, { id: 2 }],
        keys: ['one', 'other'],
      }),
    ).rejects.toThrow('Conflicting map items for [')
  })

  it('treats terminal map item updates as no-ops', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })
    await runtime.store.ensureMapItems({
      runId: run.id,
      nodeName: 'items',
      items: [{ id: 1 }, { id: 2 }],
    })

    const completed = await runtime.store.completeMapItem({
      runId: run.id,
      nodeName: 'items',
      itemIndex: 0,
      output: { value: 'done' },
    })
    const failedAfterComplete = await runtime.store.failMapItem({
      runId: run.id,
      nodeName: 'items',
      itemIndex: 0,
      error: new Error('too late'),
    })
    const failed = await runtime.store.failMapItem({
      runId: run.id,
      nodeName: 'items',
      itemIndex: 1,
      error: new Error('failed first'),
    })
    const completedAfterFail = await runtime.store.completeMapItem({
      runId: run.id,
      nodeName: 'items',
      itemIndex: 1,
      output: { value: 'too late' },
    })

    expect(completed?.status).toBe('completed')
    expect(failedAfterComplete?.status).toBe('completed')
    expect(failedAfterComplete?.output).toStrictEqual({ value: 'done' })
    expect(failed?.status).toBe('failed')
    expect(completedAfterFail?.status).toBe('failed')
    expect(completedAfterFail?.error?.message).toBe('failed first')
    expect(completedAfterFail?.output).toBeUndefined()
  })

  it('loads child state for one node only', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'parent',
      input: { scenario: 'a' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'alpha',
      kind: 'activity',
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'beta',
      kind: 'activity',
    })
    await runtime.store.ensureNodeAttempt({
      identity: { runId: run.id, nodeName: 'alpha' },
      kind: 'activity',
      input: 'alpha',
    })
    await runtime.store.ensureNodeAttempt({
      identity: { runId: run.id, nodeName: 'beta' },
      kind: 'activity',
      input: 'beta',
    })
    await runtime.store.ensureChildWorkflowRun({
      identity: { runId: run.id, nodeName: 'alpha', memberKey: 'child' },
      workflowName: 'child',
      input: 'alpha',
      parentRunId: run.id,
      parentNodeName: 'alpha',
      rootRunId: run.rootRunId,
    })
    await runtime.store.ensureChildWorkflowRun({
      identity: { runId: run.id, nodeName: 'beta', memberKey: 'child' },
      workflowName: 'child',
      input: 'beta',
      parentRunId: run.id,
      parentNodeName: 'beta',
      rootRunId: run.rootRunId,
    })
    await runtime.store.ensureMapItems({
      runId: run.id,
      nodeName: 'alpha',
      items: ['a'],
    })
    await runtime.store.ensureMapItems({
      runId: run.id,
      nodeName: 'beta',
      items: ['b'],
    })

    const alphaChildren = await runtime.store.loadNodeChildren({
      runId: run.id,
      nodeName: 'alpha',
    })

    expect(alphaChildren.attempts).toHaveLength(1)
    expect(alphaChildren.attempts[0]?.nodeName).toBe('alpha')
    expect(alphaChildren.childLinks).toHaveLength(1)
    expect(alphaChildren.childLinks[0]?.parentNodeName).toBe('alpha')
    expect(alphaChildren.mapItems).toHaveLength(1)
    expect(alphaChildren.mapItems[0]?.nodeName).toBe('alpha')
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
      leaseToken: 'activity-attempt-lease',
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
    expect(requeuedRun).toBeNull()

    await waitForReleaseBackoff()

    const delayedRequeuedRun = await runtime.runCoordinationExecutor.claim({
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      leaseMs: 30_000,
    })
    expect(delayedRequeuedRun?.command.runId).toBe('run-1')
    await runtime.runCoordinationExecutor.ack(delayedRequeuedRun!)

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

    expect(claimedActivity?.command.leaseToken).toBe('activity-attempt-lease')
    expect(claimedActivity?.leaseToken).not.toBe(activityCommand.leaseToken)
    expect(claimedActivity?.leaseToken).not.toBe(activityCommand.attemptId)
    expect(claimedTask?.command.leaseToken).toBe('task-lease')
    expect(claimedTask?.leaseToken).not.toBe(taskCommand.leaseToken)
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
    expect(releasedActivity).toBeNull()

    await waitForReleaseBackoff()

    const delayedReleasedActivity = await runtime.attemptExecutor.claimActivity(
      {
        workerId: 'worker-1',
        workflowNames: ['case-generation'],
        leaseMs: 30_000,
      },
    )
    expect(delayedReleasedActivity?.leaseToken).not.toBe(
      claimedActivity?.leaseToken,
    )
    await runtime.attemptExecutor.release(claimedActivity!)
    expect(runtime.inspect().activityCommands).toHaveLength(0)
    await runtime.attemptExecutor.ack(delayedReleasedActivity!)
    await runtime.attemptExecutor.release(delayedReleasedActivity!)
    await runtime.attemptExecutor.ack(claimedTask!)
    await runtime.attemptExecutor.release(claimedTask!)

    expect(runtime.inspect().activityCommands).toHaveLength(0)
    expect(runtime.inspect().taskCommands).toHaveLength(0)
  })
})
