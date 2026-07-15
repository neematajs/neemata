import { describe, expect, it } from 'vitest'

import {
  createInMemoryWorkflowRuntime,
  itemChildKey,
  memberChildKey,
  SELF_CHILD_KEY,
} from '../src/runtime/index.ts'

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
    await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'content',
      children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
    })
    const firstAttempt = (
      await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: SELF_CHILD_KEY,
        input: { scenario: 'a' },
      })
    ).attempt
    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      childKey: SELF_CHILD_KEY,
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

    expect(sameNode.status).toBe('pending')
    expect(firstAttempt.status).toBe('started')
    expect(firstAttempt.leaseToken).toEqual(expect.any(String))
    expect(firstAttempt.attemptNumber).toBe(1)
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
    expect(snapshot?.attempts).toHaveLength(2)
    expect(snapshot?.attempts[1]?.output).toStrictEqual({ text: 'fresh' })
    expect(snapshot?.children).toHaveLength(1)
    expect(snapshot?.children[0]?.currentAttemptId).toBe(secondAttempt.id)
    expect(snapshot?.children[0]?.attemptCount).toBe(2)
    expect(snapshot?.children[0]?.status).toBe('completed')
    expect(snapshot?.children[0]?.output).toStrictEqual({ text: 'fresh' })

    await expect(
      runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: SELF_CHILD_KEY,
        input: { scenario: 'a' },
      }),
    ).rejects.toThrow(
      `Terminal node child [${run.id}.content.${SELF_CHILD_KEY}] cannot create attempt`,
    )
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
    await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'content',
      children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
    })
    const firstAttempt = (
      await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: SELF_CHILD_KEY,
        input: { scenario: 'a' },
      })
    ).attempt
    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      childKey: SELF_CHILD_KEY,
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

    // failCurrentAttempt touches only the attempt; the child stays retryable.
    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.children[0]?.status).toBe('running')
  })

  it('records timed-out current attempts and ignores stale timeout writes', async () => {
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
    await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'content',
      children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
    })
    const firstAttempt = (
      await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: SELF_CHILD_KEY,
        input: { scenario: 'a' },
      })
    ).attempt
    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      childKey: SELF_CHILD_KEY,
      input: { scenario: 'a' },
    })

    const stale = await runtime.store.timeoutCurrentAttempt({
      attemptId: firstAttempt.id,
      leaseToken: firstAttempt.leaseToken!,
      error: new Error('stale timeout'),
    })
    const wrongToken = await runtime.store.timeoutCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: firstAttempt.leaseToken!,
      error: new Error('wrong token'),
    })
    const timedOut = await runtime.store.timeoutCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: secondAttempt.leaseToken!,
      error: new Error('fresh timeout'),
    })
    const failedAfterTimeout = await runtime.store.failCurrentAttempt({
      attemptId: secondAttempt.id,
      leaseToken: secondAttempt.leaseToken!,
      error: new Error('too late'),
    })

    expect(stale).toBeUndefined()
    expect(wrongToken).toBeUndefined()
    expect(timedOut?.status).toBe('timedOut')
    expect(timedOut?.error?.message).toBe('fresh timeout')
    expect(failedAfterTimeout).toBeUndefined()
  })

  it('requires an existing node before children and an existing child before attempts', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    await expect(
      runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'content',
        children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
      }),
    ).rejects.toThrow(`Missing node [${run.id}.content]`)

    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })

    await expect(
      runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: SELF_CHILD_KEY,
        input: { scenario: 'a' },
      }),
    ).rejects.toThrow(
      `Missing node child [${run.id}.content.${SELF_CHILD_KEY}]`,
    )
    await expect(
      runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: SELF_CHILD_KEY,
        input: { scenario: 'a' },
      }),
    ).rejects.toThrow(
      `Missing node child [${run.id}.content.${SELF_CHILD_KEY}]`,
    )
  })

  it('ensures node children and first attempts idempotently by child key', async () => {
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
    const childKey = memberChildKey('member-a')

    const firstEnsure = await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'content',
      children: [{ childKey, kind: 'activity' }],
    })
    const secondEnsure = await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'content',
      children: [{ childKey, kind: 'activity' }],
    })
    const first = await runtime.store.ensureChildAttempt({
      runId: run.id,
      nodeName: 'content',
      childKey,
      input: { scenario: 'a' },
    })
    const second = await runtime.store.ensureChildAttempt({
      runId: run.id,
      nodeName: 'content',
      childKey,
      input: { scenario: 'a' },
    })
    const snapshot = await runtime.store.loadRunSnapshot(run.id)

    expect(firstEnsure.created).toBe(true)
    expect(secondEnsure.created).toBe(false)
    expect(secondEnsure.children).toStrictEqual(firstEnsure.children)
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.attempt.id).toBe(first.attempt.id)
    expect(first.attempt.childKey).toBe(childKey)
    expect(first.attempt.attemptNumber).toBe(1)
    expect(snapshot?.children[0]?.status).toBe('running')
    expect(snapshot?.children[0]?.currentAttemptId).toBe(first.attempt.id)
    expect(snapshot?.nodes[0]?.status).toBe('running')
  })

  it('rejects conflicting node child sets', async () => {
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
    await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'content',
      children: [{ childKey: SELF_CHILD_KEY, kind: 'activity' }],
    })

    // Same key with another primitive kind is a definition conflict.
    await expect(
      runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'content',
        children: [{ childKey: SELF_CHILD_KEY, kind: 'task' }],
      }),
    ).rejects.toThrow(`Conflicting node children [${run.id}.content]`)
    // A different child set for the same node is a definition conflict too.
    await expect(
      runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'content',
        children: [{ childKey: memberChildKey('other'), kind: 'activity' }],
      }),
    ).rejects.toThrow(`Conflicting node children [${run.id}.content]`)
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

  it('numbers attempts per child so parallel members retry independently', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'fanout-workflow',
      input: {},
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'fanout',
      kind: 'parallel',
    })
    await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'fanout',
      children: [
        { childKey: memberChildKey('a'), kind: 'activity' },
        { childKey: memberChildKey('b'), kind: 'activity' },
      ],
    })

    const memberA = await runtime.store.ensureChildAttempt({
      runId: run.id,
      nodeName: 'fanout',
      childKey: memberChildKey('a'),
      input: 'a',
    })
    const memberB = await runtime.store.ensureChildAttempt({
      runId: run.id,
      nodeName: 'fanout',
      childKey: memberChildKey('b'),
      input: 'b',
    })
    await runtime.store.failCurrentAttempt({
      attemptId: memberA.attempt.id,
      leaseToken: memberA.attempt.leaseToken!,
      error: new Error('first try failed'),
    })
    const memberARetry = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'fanout',
      childKey: memberChildKey('a'),
      input: 'a',
    })

    // The stale first attempt can no longer settle member a.
    const staleComplete = await runtime.store.completeCurrentAttempt({
      attemptId: memberA.attempt.id,
      leaseToken: memberA.attempt.leaseToken!,
      output: 'stale',
    })

    expect(memberA.attempt.attemptNumber).toBe(1)
    expect(memberB.attempt.attemptNumber).toBe(1)
    expect(memberARetry.attemptNumber).toBe(2)
    expect(staleComplete).toBeUndefined()

    const { children } = await runtime.store.loadNodeChildren({
      runId: run.id,
      nodeName: 'fanout',
    })
    const childA = children.find(
      (child) => child.childKey === memberChildKey('a'),
    )
    const childB = children.find(
      (child) => child.childKey === memberChildKey('b'),
    )
    expect(childA?.attemptCount).toBe(2)
    expect(childA?.currentAttemptId).toBe(memberARetry.id)
    expect(childB?.attemptCount).toBe(1)
  })

  it('ensures child runs idempotently and links them to the child record', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'parent',
      input: { scenario: 'a' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'child',
      kind: 'workflow',
    })
    await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'child',
      children: [{ childKey: SELF_CHILD_KEY, kind: 'workflow' }],
    })
    const params = {
      runId: run.id,
      nodeName: 'child',
      childKey: SELF_CHILD_KEY,
      childKind: 'workflow' as const,
      childName: 'child',
      input: { scenario: 'a' },
      rootRunId: run.rootRunId,
    }

    const first = await runtime.store.ensureChildRun(params)
    const second = await runtime.store.ensureChildRun(params)

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.childRun.id).toBe(first.childRun.id)
    expect(second.child.childRunId).toBe(first.childRun.id)
    expect(first.child.status).toBe('running')
    expect(first.childRun.parentRunId).toBe(run.id)
    expect(first.childRun.parentNodeName).toBe('child')
    expect(first.childRun.rootRunId).toBe(run.rootRunId)

    await expect(
      runtime.store.ensureChildRun({
        ...params,
        input: { scenario: 'different' },
      }),
    ).rejects.toThrow(
      `Conflicting child run [${run.id}.child.${SELF_CHILD_KEY}]`,
    )
  })

  it('rejects child runs whose child record was never ensured', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'parent',
      input: { scenario: 'a' },
    })

    await expect(
      runtime.store.ensureChildRun({
        runId: run.id,
        nodeName: 'child',
        childKey: SELF_CHILD_KEY,
        childKind: 'workflow',
        childName: 'child',
        input: { scenario: 'a' },
        rootRunId: run.rootRunId,
      }),
    ).rejects.toThrow(`Missing node child [${run.id}.child.${SELF_CHILD_KEY}]`)
  })

  it('ensures map item children once and rejects conflicting shapes', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'items',
      kind: 'mapTask',
    })

    const first = await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'items',
      children: [
        {
          childKey: itemChildKey(0),
          kind: 'task',
          ordinal: 0,
          itemKey: 'one',
          item: { id: 1 },
        },
        {
          childKey: itemChildKey(1),
          kind: 'task',
          ordinal: 1,
          itemKey: 'two',
          item: { id: 2 },
        },
      ],
    })
    const same = await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'items',
      children: [
        {
          childKey: itemChildKey(0),
          kind: 'task',
          ordinal: 0,
          itemKey: 'one',
          item: { id: 1 },
        },
        {
          childKey: itemChildKey(1),
          kind: 'task',
          ordinal: 1,
          itemKey: 'two',
          item: { id: 2 },
        },
      ],
    })

    expect(first.created).toBe(true)
    expect(same.created).toBe(false)
    expect(same.children).toStrictEqual(first.children)
    expect(first.children.map((child) => child.ordinal)).toStrictEqual([0, 1])
    // Fewer items than the stored set is a conflict.
    await expect(
      runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'items',
        children: [
          {
            childKey: itemChildKey(0),
            kind: 'task',
            ordinal: 0,
            itemKey: 'one',
            item: { id: 1 },
          },
        ],
      }),
    ).rejects.toThrow('Conflicting node children [')
    // Same set with a different item key is a conflict.
    await expect(
      runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'items',
        children: [
          {
            childKey: itemChildKey(0),
            kind: 'task',
            ordinal: 0,
            itemKey: 'one',
            item: { id: 1 },
          },
          {
            childKey: itemChildKey(1),
            kind: 'task',
            ordinal: 1,
            itemKey: 'other',
            item: { id: 2 },
          },
        ],
      }),
    ).rejects.toThrow('Conflicting node children [')
  })

  it('treats terminal node child updates as no-ops', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'items',
      kind: 'mapTask',
    })
    await runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'items',
      children: [
        {
          childKey: itemChildKey(0),
          kind: 'task',
          ordinal: 0,
          item: { id: 1 },
        },
        {
          childKey: itemChildKey(1),
          kind: 'task',
          ordinal: 1,
          item: { id: 2 },
        },
      ],
    })

    const completed = await runtime.store.completeNodeChild({
      runId: run.id,
      nodeName: 'items',
      childKey: itemChildKey(0),
      output: { value: 'done' },
    })
    const failedAfterComplete = await runtime.store.failNodeChild({
      runId: run.id,
      nodeName: 'items',
      childKey: itemChildKey(0),
      error: new Error('too late'),
    })
    const failed = await runtime.store.failNodeChild({
      runId: run.id,
      nodeName: 'items',
      childKey: itemChildKey(1),
      error: new Error('failed first'),
    })
    const completedAfterFail = await runtime.store.completeNodeChild({
      runId: run.id,
      nodeName: 'items',
      childKey: itemChildKey(1),
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

  it('transitions run status between running and waiting truthfully', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'case-generation',
      input: { scenario: 'a' },
    })

    // queued → waiting is not a legal transition; the run stays queued.
    const waitingBeforeStart = await runtime.store.markRunWaiting({
      runId: run.id,
    })
    const running = await runtime.store.markRunRunning({ runId: run.id })
    const runningAgain = await runtime.store.markRunRunning({ runId: run.id })
    const waiting = await runtime.store.markRunWaiting({ runId: run.id })
    const resumed = await runtime.store.markRunRunning({ runId: run.id })

    expect(waitingBeforeStart?.status).toBe('queued')
    expect(running?.status).toBe('running')
    expect(running?.version).toBe(run.version + 1)
    expect(runningAgain?.status).toBe('running')
    expect(runningAgain?.version).toBe(running?.version)
    expect(waiting?.status).toBe('waiting')
    expect(resumed?.status).toBe('running')

    await runtime.store.completeRun({ runId: run.id, output: { ok: true } })
    const runningAfterTerminal = await runtime.store.markRunRunning({
      runId: run.id,
    })
    const waitingAfterTerminal = await runtime.store.markRunWaiting({
      runId: run.id,
    })
    expect(runningAfterTerminal?.status).toBe('completed')
    expect(waitingAfterTerminal?.status).toBe('completed')
  })

  it('loads child state for one node only', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'parent',
      input: { scenario: 'a' },
    })
    for (const nodeName of ['alpha', 'beta']) {
      await runtime.store.createNode({
        runId: run.id,
        name: nodeName,
        kind: 'parallel',
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName,
        children: [
          { childKey: memberChildKey('work'), kind: 'activity', ordinal: 0 },
          { childKey: memberChildKey('sub'), kind: 'workflow', ordinal: 1 },
        ],
      })
      await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName,
        childKey: memberChildKey('work'),
        input: nodeName,
      })
      await runtime.store.ensureChildRun({
        runId: run.id,
        nodeName,
        childKey: memberChildKey('sub'),
        childKind: 'workflow',
        childName: 'child',
        input: nodeName,
        rootRunId: run.rootRunId,
      })
    }

    const alphaChildren = await runtime.store.loadNodeChildren({
      runId: run.id,
      nodeName: 'alpha',
    })

    expect(alphaChildren.attempts).toHaveLength(1)
    expect(alphaChildren.attempts[0]?.nodeName).toBe('alpha')
    expect(alphaChildren.children).toHaveLength(2)
    expect(
      alphaChildren.children.every((child) => child.nodeName === 'alpha'),
    ).toBe(true)
    const subChild = alphaChildren.children.find(
      (child) => child.childKey === memberChildKey('sub'),
    )
    expect(subChild?.childRunId).toEqual(expect.any(String))
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
      childKey: SELF_CHILD_KEY,
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
      childKey: SELF_CHILD_KEY,
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

    const claimedActivity = await runtime.attemptExecutor.claim({
      taskNames: [],
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      activityNames: ['writeContent'],
      leaseMs: 30_000,
    })
    const claimedTask = await runtime.attemptExecutor.claim({
      workflowNames: [],
      activityNames: [],
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

    const releasedActivity = await runtime.attemptExecutor.claim({
      taskNames: [],
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      activityNames: ['writeContent'],
      leaseMs: 30_000,
    })
    expect(releasedActivity).toBeNull()

    await waitForReleaseBackoff()

    const delayedReleasedActivity = await runtime.attemptExecutor.claim({
      taskNames: [],
      workerId: 'worker-1',
      workflowNames: ['case-generation'],
      activityNames: ['writeContent'],
      leaseMs: 30_000,
    })
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
