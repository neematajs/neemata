import { t } from '@nmtjs/type'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  defineTask,
  defineWorkflow,
  type WorkflowRuntimeAdapter,
} from '../src/index.ts'
import {
  createPostgresWorkflowRuntime,
  installPostgresWorkflowSchemaForTesting,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'

type RuntimeFactory = () => WorkflowRuntimeAdapter | Promise<WorkflowRuntimeAdapter>

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createPgliteConnection(db = new PGlite()): WorkflowPostgresConnection {
  return {
    query: (sql, params = []) => db.query(sql, [...params]),
    transaction: (handler) =>
      db.transaction((tx) =>
        handler({
          query: (sql, params = []) => tx.query(sql, [...params]),
          transaction: (nested) => nested(createPgliteConnection(db)),
        }),
      ),
  }
}

function workflowRuntimeAdapterContract(
  name: string,
  createRuntime: RuntimeFactory,
) {
  describe(`${name} workflow runtime adapter contract`, () => {
    it('starts workflow runs through the runtime client', async () => {
      const workflow = defineWorkflow({
        name: 'adapter-contract-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)

      const run = await client.start(workflow, { scenario: 'alpha' })
      const snapshot = await client.get(run.id)

      expect(run).toMatchObject({
        kind: 'workflow',
        name: workflow.name,
        workflowName: workflow.name,
        status: 'queued',
        input: { scenario: 'alpha' },
      })
      expect(snapshot?.run.id).toBe(run.id)

      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'coordinator-1',
        workflowNames: [workflow.name],
        leaseMs: 30_000,
      })

      expect(claimed?.command).toStrictEqual({
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      })
      if (name === 'postgres') {
        expect(run.id).toMatch(uuidPattern)
        expect(claimed?.id).toMatch(uuidPattern)
      }
    })

    it('starts task runs through the runtime client', async () => {
      const task = defineTask({
        name: 'adapter-contract-task',
        input: t.object({ text: t.string() }),
        output: t.object({ id: t.string() }),
      })
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)

      const run = await client.start(task, { text: 'alpha' })
      const snapshot = await client.get(run.id)
      const claimed = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-1',
        taskNames: [task.name],
        leaseMs: 30_000,
      })

      expect(run).toMatchObject({
        kind: 'task',
        name: task.name,
        workflowName: task.name,
        taskName: task.name,
        status: 'queued',
        input: { text: 'alpha' },
      })
      expect(snapshot?.nodes).toMatchObject([
        {
          runId: run.id,
          name: '$task',
          kind: 'task',
          status: 'waiting',
          input: { text: 'alpha' },
        },
      ])
      expect(claimed?.command).toMatchObject({
        kind: 'taskAttempt',
        runId: run.id,
        taskName: task.name,
        nodeName: '$task',
        input: { text: 'alpha' },
      })
      if (name === 'postgres') {
        expect(run.id).toMatch(uuidPattern)
        expect(claimed?.id).toMatch(uuidPattern)
        expect(claimed?.command.attemptId).toMatch(uuidPattern)
        expect(claimed?.command.leaseToken).toMatch(uuidPattern)
      }
    })

    it('claims, acks, and releases run coordination commands', async () => {
      const runtime = await createRuntime()
      const command = {
        kind: 'continueRun' as const,
        runId: '00000000-0000-4000-8000-000000000101',
        workflowName: 'claimable-workflow',
      }

      await runtime.runCoordinationExecutor.enqueue(command)

      const first = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-1',
        workflowNames: ['claimable-workflow'],
        leaseMs: 30_000,
      })
      const noneWhileClaimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-2',
        workflowNames: ['claimable-workflow'],
        leaseMs: 30_000,
      })

      expect(first?.command).toStrictEqual(command)
      expect(noneWhileClaimed).toBeNull()

      await runtime.runCoordinationExecutor.release(first!)

      const reclaimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-2',
        workflowNames: ['claimable-workflow'],
        leaseMs: 30_000,
      })

      expect(reclaimed?.command).toStrictEqual(command)

      await runtime.runCoordinationExecutor.ack(reclaimed!)

      const afterAck = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-3',
        workflowNames: ['claimable-workflow'],
        leaseMs: 30_000,
      })
      expect(afterAck).toBeNull()
    })

    it('claims, heartbeats, acks, and releases attempt commands', async () => {
      const runtime = await createRuntime()
      const activityCommand = {
        kind: 'activityAttempt' as const,
        workflowName: 'attempt-workflow',
        activityName: 'content',
        runId: '00000000-0000-4000-8000-000000000201',
        nodeName: 'content',
        attemptId: '00000000-0000-4000-8000-000000000202',
        leaseToken: 'lease-activity',
        input: { scenario: 'alpha' },
      }
      const taskCommand = {
        kind: 'taskAttempt' as const,
        workflowName: 'attempt-task',
        taskName: 'embedding',
        runId: '00000000-0000-4000-8000-000000000203',
        nodeName: '$task',
        attemptId: '00000000-0000-4000-8000-000000000204',
        leaseToken: 'lease-task',
        input: { text: 'alpha' },
      }

      await runtime.attemptExecutor.dispatchActivity(activityCommand)
      await runtime.attemptExecutor.dispatchTask(taskCommand)

      const wrongWorkflow = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-1',
        workflowNames: ['other-workflow'],
        leaseMs: 30_000,
      })
      const wrongActivity = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-1',
        workflowNames: ['attempt-workflow'],
        activityNames: ['other-activity'],
        leaseMs: 30_000,
      })
      const activity = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-1',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      const noneWhileActivityClaimed =
        await runtime.attemptExecutor.claimActivity({
          workerId: 'activity-worker-2',
          workflowNames: ['attempt-workflow'],
          activityNames: ['content'],
          leaseMs: 30_000,
        })

      expect(wrongWorkflow).toBeNull()
      expect(wrongActivity).toBeNull()
      expect(activity?.command).toStrictEqual(activityCommand)
      expect(noneWhileActivityClaimed).toBeNull()

      await runtime.attemptExecutor.heartbeat(activity!)
      await runtime.attemptExecutor.release(activity!)

      const reclaimedActivity = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-2',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      expect(reclaimedActivity?.command).toStrictEqual(activityCommand)

      await runtime.attemptExecutor.ack(reclaimedActivity!)

      const activityAfterAck = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-3',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      expect(activityAfterAck).toBeNull()

      const wrongTask = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-1',
        taskNames: ['other-task'],
        leaseMs: 30_000,
      })
      const task = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-1',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })

      expect(wrongTask).toBeNull()
      expect(task?.command).toStrictEqual(taskCommand)

      await runtime.attemptExecutor.release(task!)

      const reclaimedTask = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-2',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })
      expect(reclaimedTask?.command).toStrictEqual(taskCommand)

      await runtime.attemptExecutor.ack(reclaimedTask!)

      const taskAfterAck = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-3',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })
      expect(taskAfterAck).toBeNull()
    })

    it('leases one coordinator per run and ignores stale lease release', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'lease-workflow',
        input: {},
      })
      const missing = await runtime.store.acquireRunLease({
        runId: 'missing-run',
        workerId: 'worker-0',
        leaseMs: 30_000,
      })

      const expired = await runtime.store.acquireRunLease({
        runId: run.id,
        workerId: 'worker-1',
        leaseMs: 0,
      })
      const current = await runtime.store.acquireRunLease({
        runId: run.id,
        workerId: 'worker-2',
        leaseMs: 30_000,
      })
      const busy = await runtime.store.acquireRunLease({
        runId: run.id,
        workerId: 'worker-3',
        leaseMs: 30_000,
      })

      expect(missing).toBeUndefined()
      expect(expired).toBeDefined()
      expect(current).toBeDefined()
      expect(current?.leaseToken).not.toBe(expired?.leaseToken)
      expect(busy).toBeUndefined()

      await runtime.store.releaseRunLease(expired!)

      const stillBusy = await runtime.store.acquireRunLease({
        runId: run.id,
        workerId: 'worker-3',
        leaseMs: 30_000,
      })
      expect(stillBusy).toBeUndefined()

      await runtime.store.releaseRunLease(current!)

      const next = await runtime.store.acquireRunLease({
        runId: run.id,
        workerId: 'worker-3',
        leaseMs: 30_000,
      })
      expect(next).toBeDefined()
    })

    it('creates idempotent runs once and rejects conflicting run starts', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'idempotent-workflow',
        input: { scenario: 'alpha' },
        idempotencyKey: ['workflow', 'alpha'],
      })
      const same = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'idempotent-workflow',
        input: { scenario: 'alpha' },
        idempotencyKey: ['workflow', 'alpha'],
      })

      expect(same.id).toBe(run.id)
      expect(same.input).toStrictEqual({ scenario: 'alpha' })

      await expect(
        runtime.store.createRun({
          kind: 'workflow',
          workflowName: 'idempotent-workflow',
          input: { scenario: 'beta' },
          idempotencyKey: ['workflow', 'alpha'],
        }),
      ).rejects.toThrow('Conflicting idempotent run')

      await expect(
        runtime.store.createRun({
          kind: 'task',
          workflowName: 'idempotent-task',
          taskName: 'idempotent-task',
          input: { scenario: 'alpha' },
          idempotencyKey: ['workflow', 'alpha'],
        }),
      ).rejects.toThrow('Conflicting idempotent run')
    })

    it('ignores stale completions and terminal state rewrites', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'completion-workflow',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'content',
        kind: 'activity',
      })
      const firstAttempt = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        input: { value: 1 },
      })
      const secondAttempt = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        input: { value: 2 },
      })

      const stale = await runtime.store.completeCurrentAttempt({
        attemptId: firstAttempt.id,
        leaseToken: firstAttempt.leaseToken!,
        output: { text: 'stale' },
      })
      const wrongToken = await runtime.store.completeCurrentAttempt({
        attemptId: secondAttempt.id,
        leaseToken: firstAttempt.leaseToken!,
        output: { text: 'wrong-token' },
      })
      const completed = await runtime.store.completeCurrentAttempt({
        attemptId: secondAttempt.id,
        leaseToken: secondAttempt.leaseToken!,
        output: { text: 'fresh' },
      })
      const duplicate = await runtime.store.completeCurrentAttempt({
        attemptId: secondAttempt.id,
        leaseToken: secondAttempt.leaseToken!,
        output: { text: 'duplicate' },
      })
      const failAfterComplete = await runtime.store.failCurrentAttempt({
        attemptId: secondAttempt.id,
        leaseToken: secondAttempt.leaseToken!,
        error: new Error('too-late'),
      })
      const completedNode = await runtime.store.completeNode({
        runId: run.id,
        nodeName: 'content',
        output: { text: 'node' },
      })
      const failedNode = await runtime.store.failNode({
        runId: run.id,
        nodeName: 'content',
        error: new Error('too-late'),
      })
      const completedRun = await runtime.store.completeRun({
        runId: run.id,
        output: { ok: true },
      })
      const failedRun = await runtime.store.failRun({
        runId: run.id,
        error: new Error('too-late'),
      })

      expect(stale).toBeUndefined()
      expect(wrongToken).toBeUndefined()
      expect(completed?.output).toStrictEqual({ text: 'fresh' })
      expect(duplicate).toBeUndefined()
      expect(failAfterComplete).toBeUndefined()
      expect(completedNode?.status).toBe('completed')
      expect(failedNode?.status).toBe('completed')
      expect(failedNode?.output).toStrictEqual({ text: 'node' })
      expect(completedRun?.status).toBe('completed')
      expect(failedRun?.status).toBe('completed')
      expect(failedRun?.output).toStrictEqual({ ok: true })
    })

    it('ensures child links and map items atomically', async () => {
      const runtime = await createRuntime()
      const parent = await runtime.store.createRun({
        workflowName: 'parent',
        input: { scenario: 'alpha' },
      })
      await runtime.store.createNode({
        runId: parent.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.createNode({
        runId: parent.id,
        name: 'items',
        kind: 'mapTask',
      })
      await runtime.store.createNode({
        runId: parent.id,
        name: 'duplicate-items',
        kind: 'mapTask',
      })
      const childParams = {
        identity: { runId: parent.id, nodeName: 'child' },
        childKind: 'workflow' as const,
        childName: 'child',
        input: { scenario: 'alpha' },
        parentRunId: parent.id,
        parentNodeName: 'child',
        rootRunId: parent.rootRunId,
      }

      const firstChild = await runtime.store.ensureChildRun(childParams)
      const sameChild = await runtime.store.ensureChildRun(childParams)
      const firstItems = await runtime.store.ensureMapItems({
        runId: parent.id,
        nodeName: 'items',
        items: [{ id: 1 }, { id: 2 }],
        keys: ['one', 'two'],
      })
      const sameItems = await runtime.store.ensureMapItems({
        runId: parent.id,
        nodeName: 'items',
        items: [{ id: 1 }, { id: 2 }],
        keys: ['one', 'two'],
      })

      expect(firstChild.created).toBe(true)
      expect(sameChild.created).toBe(false)
      expect(sameChild.childRun.id).toBe(firstChild.childRun.id)
      await expect(
        runtime.store.ensureChildRun({
          ...childParams,
          childName: 'other-child',
        }),
      ).rejects.toThrow('Conflicting child run')
      await expect(
        runtime.store.ensureChildRun({
          ...childParams,
          input: { scenario: 'beta' },
        }),
      ).rejects.toThrow('Conflicting child run')
      expect(firstItems.created).toBe(true)
      expect(sameItems.created).toBe(false)
      expect(sameItems.items).toStrictEqual(firstItems.items)
      await expect(
        runtime.store.ensureMapItems({
          runId: parent.id,
          nodeName: 'duplicate-items',
          items: [{ id: 1 }, { id: 2 }],
          keys: ['same', 'same'],
        }),
      ).rejects.toThrow('Duplicate map item key')
      await expect(
        runtime.store.ensureMapItems({
          runId: parent.id,
          nodeName: 'items',
          items: [{ id: 1 }],
          keys: ['one'],
        }),
      ).rejects.toThrow('Conflicting map items')
      await expect(
        runtime.store.ensureMapItems({
          runId: parent.id,
          nodeName: 'items',
          items: [{ id: 1 }, { id: 999 }],
          keys: ['one', 'two'],
        }),
      ).rejects.toThrow('Conflicting map items')
    })

    it('loads run snapshots without leaking state across runs', async () => {
      const runtime = await createRuntime()
      const first = await runtime.store.createRun({
        workflowName: 'first',
        input: { run: 1 },
      })
      const second = await runtime.store.createRun({
        workflowName: 'second',
        input: { run: 2 },
      })
      await runtime.store.createNode({
        runId: first.id,
        name: 'first-node',
        kind: 'activity',
      })
      await runtime.store.createNode({
        runId: second.id,
        name: 'second-node',
        kind: 'activity',
      })
      await runtime.store.createAttempt({
        runId: first.id,
        nodeName: 'first-node',
        input: { run: 1 },
      })
      await runtime.store.createAttempt({
        runId: second.id,
        nodeName: 'second-node',
        input: { run: 2 },
      })
      await runtime.store.createNode({
        runId: first.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.createNode({
        runId: first.id,
        name: 'items',
        kind: 'mapTask',
      })
      await runtime.store.ensureChildRun({
        identity: { runId: first.id, nodeName: 'child' },
        childKind: 'workflow',
        childName: 'child',
        input: { run: 1 },
        parentRunId: first.id,
        parentNodeName: 'child',
        rootRunId: first.rootRunId,
      })
      await runtime.store.ensureMapItems({
        runId: first.id,
        nodeName: 'items',
        items: [{ run: 1 }],
        keys: ['one'],
      })

      const firstSnapshot = await runtime.store.loadRunSnapshot(first.id)
      const secondSnapshot = await runtime.store.loadRunSnapshot(second.id)

      expect(firstSnapshot?.run.id).toBe(first.id)
      expect(firstSnapshot?.nodes.map((node) => node.name)).toEqual(
        expect.arrayContaining(['first-node', 'child', 'items']),
      )
      expect(firstSnapshot?.attempts.map((attempt) => attempt.runId)).toStrictEqual([
        first.id,
      ])
      expect(firstSnapshot?.childLinks).toHaveLength(1)
      expect(firstSnapshot?.mapItems).toHaveLength(1)
      expect(secondSnapshot?.run.id).toBe(second.id)
      expect(secondSnapshot?.nodes.map((node) => node.name)).toStrictEqual([
        'second-node',
      ])
      expect(secondSnapshot?.attempts.map((attempt) => attempt.runId)).toStrictEqual([
        second.id,
      ])
      expect(secondSnapshot?.childLinks).toStrictEqual([])
      expect(secondSnapshot?.mapItems).toStrictEqual([])
    })

    it('lists runs by structural filters and JSON input containment', async () => {
      const runtime = await createRuntime()
      const workflowRun = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'curriculum-generation',
        input: {
          curriculumId: 'curriculum-1',
          nested: { scenario: 'alpha', values: [1, 2, 3] },
        },
        tags: { tenantId: 'tenant-1', domain: 'clinical' },
      })
      const taskRun = await runtime.store.createRun({
        kind: 'task',
        workflowName: 'embedding.generate',
        taskName: 'embedding.generate',
        input: { text: 'hello', curriculumId: 'curriculum-1' },
        tags: { tenantId: 'tenant-1', domain: 'ai' },
      })
      await runtime.store.createNode({
        runId: workflowRun.id,
        name: 'caseRuns',
        kind: 'mapWorkflow',
      })
      const childRun = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'case-generation',
        input: { curriculumId: 'curriculum-2', nested: { scenario: 'beta' } },
        parentRunId: workflowRun.id,
        parentNodeName: 'caseRuns',
        rootRunId: workflowRun.rootRunId,
        tags: { tenantId: 'tenant-2', domain: 'clinical' },
      })
      await runtime.store.completeRun({
        runId: childRun.id,
        output: { caseId: 'case-1' },
      })

      await expect(
        runtime.store.listRuns({
          kind: 'workflow',
          name: 'case-generation',
          status: 'completed',
          parentRunId: workflowRun.id,
          rootRunId: workflowRun.rootRunId,
          tags: { tenantId: 'tenant-2' },
          input: { nested: { scenario: 'beta' } },
        }),
      ).resolves.toMatchObject({
        runs: [{ id: childRun.id }],
      })
      await expect(
        runtime.store.listRuns({
          kind: 'task',
          name: 'embedding.generate',
          tags: { domain: 'ai' },
          input: { curriculumId: 'curriculum-1' },
        }),
      ).resolves.toMatchObject({
        runs: [{ id: taskRun.id }],
      })
      await expect(
        runtime.store.listRuns({
          input: { nested: { values: [1, 2] } },
        }),
      ).resolves.toMatchObject({
        runs: [{ id: workflowRun.id }],
      })
      await expect(
        runtime.store.listRuns({
          input: { nested: { missing: true } },
        }),
      ).resolves.toStrictEqual({ runs: [] })
    })

    it('lists runs newest first with cursor pagination', async () => {
      const runtime = await createRuntime()
      const first = await runtime.store.createRun({
        workflowName: 'pageable',
        input: { index: 1 },
      })
      const second = await runtime.store.createRun({
        workflowName: 'pageable',
        input: { index: 2 },
      })
      const third = await runtime.store.createRun({
        workflowName: 'pageable',
        input: { index: 3 },
      })

      const firstPage = await runtime.store.listRuns({
        name: 'pageable',
        limit: 2,
      })
      const secondPage = await runtime.store.listRuns({
        name: 'pageable',
        cursor: firstPage.nextCursor,
        limit: 2,
      })

      expect(firstPage.runs.map((run) => run.id)).toStrictEqual([
        third.id,
        second.id,
      ])
      expect(firstPage.nextCursor).toBeDefined()
      expect(secondPage.runs.map((run) => run.id)).toStrictEqual([first.id])
      expect(secondPage.nextCursor).toBeUndefined()
    })
  })
}

workflowRuntimeAdapterContract('in-memory', createInMemoryWorkflowRuntime)
workflowRuntimeAdapterContract('postgres', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  return createPostgresWorkflowRuntime({ connection })
})
