import { PGlite } from '@electric-sql/pglite'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineTask, defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runWorkflowWorker,
  type WorkflowRuntimeAdapter,
} from '../src/runtime/index.ts'

type RuntimeFactoryOptions = {
  readonly maxDeliveries?: number
}

type RuntimeFactory = (
  options?: RuntimeFactoryOptions,
) => WorkflowRuntimeAdapter | Promise<WorkflowRuntimeAdapter>

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const waitForReleaseBackoff = () =>
  new Promise((resolve) => setTimeout(resolve, 60))

const createPgliteConnection = () =>
  createPostgresWorkflowConnection(new PGlite())

const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
const testContainer = new Container({ logger })

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

    it('delays workflow starts without hiding the run row', async () => {
      const workflow = defineWorkflow({
        name: 'adapter-delayed-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const startAt = new Date(Date.now() + 60_000)

      const run = await client.start(
        workflow,
        { scenario: 'alpha' },
        { startAt },
      )

      await expect(client.get(run.id)).resolves.toMatchObject({
        run: { id: run.id, status: 'queued' },
      })
      await expect(
        runtime.runCoordinationExecutor.claim({
          workerId: 'coordinator-before-start',
          workflowNames: [workflow.name],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
    })

    it('keeps delayed idempotent workflow replays from waking early', async () => {
      const workflow = defineWorkflow({
        name: 'adapter-delayed-idempotent-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const idempotencyKey = ['workflow', 'delayed-idempotent-alpha']
      const startAt = new Date(Date.now() + 60_000)

      const run = await client.start(
        workflow,
        { scenario: 'alpha' },
        { idempotencyKey, startAt },
      )
      const replay = await client.start(
        workflow,
        { scenario: 'alpha' },
        { idempotencyKey },
      )

      expect(replay.id).toBe(run.id)
      await expect(
        runtime.runCoordinationExecutor.claim({
          workerId: 'coordinator-before-idempotent-start',
          workflowNames: [workflow.name],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
    })

    it('does not enqueue consumed idempotent workflow starts again', async () => {
      const workflow = defineWorkflow({
        name: 'adapter-consumed-idempotent-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const idempotencyKey = ['workflow', 'consumed-idempotent-alpha']

      const run = await client.start(
        workflow,
        { scenario: 'alpha' },
        { idempotencyKey },
      )
      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'coordinator-consume-idempotent-start',
        workflowNames: [workflow.name],
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.ack(claimed!)
      const replay = await client.start(
        workflow,
        { scenario: 'alpha' },
        { idempotencyKey },
      )

      expect(replay.id).toBe(run.id)
      await expect(
        runtime.runCoordinationExecutor.claim({
          workerId: 'coordinator-after-idempotent-replay',
          workflowNames: [workflow.name],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
    })

    it('cancels a queued workflow run end-to-end', async () => {
      const workflow = defineWorkflow({
        name: 'adapter-cancel-queued-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const implementation = implementWorkflow(workflow).finish(
        (_ctx, _outputs, input) => ({ caseId: input.scenario }),
      )
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, { scenario: 'alpha' })

      await client.cancel(run.id)
      await runWorkflowWorker({
        ...runtime,
        container: testContainer,
        workflows: [implementation],
        workerId: 'cancel-worker-1',
      })

      const snapshot = await client.get(run.id)
      expect(snapshot?.run.status).toBe('cancelled')
      expect(snapshot?.nodes).toStrictEqual([])
    })

    it('recursively cancels a child workflow run end-to-end', async () => {
      const childWorkflow = defineWorkflow({
        name: 'adapter-cancel-child-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const parentWorkflow = defineWorkflow({
        name: 'adapter-cancel-parent-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      })
        .workflow('child', childWorkflow)
        .build()
      const childImplementation = implementWorkflow(childWorkflow).finish(
        (_ctx, _outputs, input) => ({ caseId: input.scenario }),
      )
      const parentImplementation = implementWorkflow(parentWorkflow)
        .child(childWorkflow)
        .finish((_ctx, { child }) => ({ caseId: child.caseId }))
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(parentWorkflow, { scenario: 'alpha' })

      await runWorkflowWorker({
        ...runtime,
        container: testContainer,
        workflows: [parentImplementation],
        workerId: 'parent-worker-1',
      })
      const waiting = await client.get(run.id)
      const childRunId = waiting?.children[0]?.childRunId
      expect(childRunId).toBeTypeOf('string')

      await client.cancel(run.id)
      await runWorkflowWorker({
        ...runtime,
        container: testContainer,
        workflows: [parentImplementation],
        workerId: 'parent-worker-2',
      })
      await runWorkflowWorker({
        ...runtime,
        container: testContainer,
        workflows: [childImplementation],
        workerId: 'child-worker-1',
      })

      const parentSnapshot = await client.get(run.id)
      const childSnapshot = await client.get(childRunId!)
      expect(parentSnapshot?.run.status).toBe('cancelled')
      expect(parentSnapshot?.nodes[0]?.status).toBe('cancelled')
      expect(childSnapshot?.run.status).toBe('cancelled')
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
      const claimed = await runtime.attemptExecutor.claim({
        workflowNames: [],
        activityNames: [],
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
          status: 'running',
          input: { text: 'alpha' },
        },
      ])
      expect(claimed?.command).toMatchObject({
        kind: 'taskAttempt',
        runId: run.id,
        taskName: task.name,
        nodeName: '$task',
        childKey: '$self',
        input: { text: 'alpha' },
      })
      if (name === 'postgres') {
        expect(run.id).toMatch(uuidPattern)
        expect(claimed?.id).toMatch(uuidPattern)
        expect(claimed?.command.attemptId).toMatch(uuidPattern)
        expect(claimed?.command.leaseToken).toMatch(uuidPattern)
      }
    })

    it('delays task starts without hiding the run row', async () => {
      const task = defineTask({
        name: 'adapter-delayed-task',
        input: t.object({ text: t.string() }),
        output: t.object({ id: t.string() }),
      })
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const startAt = new Date(Date.now() + 60_000)

      const run = await client.start(task, { text: 'alpha' }, { startAt })

      await expect(client.get(run.id)).resolves.toMatchObject({
        run: { id: run.id, status: 'queued' },
      })
      await expect(
        runtime.attemptExecutor.claim({
          workflowNames: [],
          activityNames: [],
          workerId: 'task-before-start',
          taskNames: [task.name],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
    })

    it('keeps delayed idempotent task replays parked', async () => {
      const task = defineTask({
        name: 'adapter-delayed-idempotent-task',
        input: t.object({ text: t.string() }),
        output: t.object({ id: t.string() }),
      })
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const idempotencyKey = ['task', 'delayed-idempotent-alpha']
      const startAt = new Date(Date.now() + 60_000)

      const run = await client.start(
        task,
        { text: 'alpha' },
        { idempotencyKey, startAt },
      )
      const replay = await client.start(
        task,
        { text: 'alpha' },
        { idempotencyKey },
      )
      const snapshot = await client.get(run.id)

      expect(replay.id).toBe(run.id)
      expect(snapshot?.nodes).toMatchObject([
        {
          runId: run.id,
          name: '$task',
          kind: 'task',
          status: 'running',
          input: { text: 'alpha' },
        },
      ])
      await expect(
        runtime.attemptExecutor.claim({
          workflowNames: [],
          activityNames: [],
          workerId: 'task-before-idempotent-start',
          taskNames: [task.name],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
    })

    it('does not enqueue consumed idempotent task starts again', async () => {
      const task = defineTask({
        name: 'adapter-consumed-idempotent-task',
        input: t.object({ text: t.string() }),
        output: t.object({ id: t.string() }),
      })
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const idempotencyKey = ['task', 'consumed-idempotent-alpha']

      const run = await client.start(
        task,
        { text: 'alpha' },
        { idempotencyKey },
      )
      const claimed = await runtime.attemptExecutor.claim({
        workflowNames: [],
        activityNames: [],
        workerId: 'task-consume-idempotent-start',
        taskNames: [task.name],
        leaseMs: 30_000,
      })
      await runtime.attemptExecutor.ack(claimed!)
      const replay = await client.start(
        task,
        { text: 'alpha' },
        { idempotencyKey },
      )

      expect(replay.id).toBe(run.id)
      await expect(
        runtime.attemptExecutor.claim({
          workflowNames: [],
          activityNames: [],
          workerId: 'task-after-idempotent-replay',
          taskNames: [task.name],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
    })

    it('claims, acks, and releases run coordination commands', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'claimable-workflow',
        input: {},
      })
      const command = {
        kind: 'continueRun' as const,
        runId: run.id,
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

      const noneBeforeBackoff = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-2',
        workflowNames: ['claimable-workflow'],
        leaseMs: 30_000,
      })
      expect(noneBeforeBackoff).toBeNull()

      await waitForReleaseBackoff()

      const reclaimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-2',
        workflowNames: ['claimable-workflow'],
        leaseMs: 30_000,
      })

      expect(reclaimed?.command).toStrictEqual(command)

      await runtime.runCoordinationExecutor.ack(reclaimed!)
      await expect(
        runtime.runCoordinationExecutor.ack({
          ...reclaimed!,
          leaseToken: 'stale-continue-lease',
        }),
      ).rejects.toThrow('Stale workflow command ack')

      const afterAck = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-3',
        workflowNames: ['claimable-workflow'],
        leaseMs: 30_000,
      })
      expect(afterAck).toBeNull()
    })

    it('coalesces unclaimed continue commands by run and keeps the latest payload', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'coalesced-workflow',
        input: {},
      })
      const first = {
        kind: 'continueRun' as const,
        runId: run.id,
        workflowName: 'coalesced-workflow',
        generation: 1,
      }
      const second = {
        kind: 'continueRun' as const,
        runId: run.id,
        workflowName: 'coalesced-workflow',
        generation: 2,
      }

      await runtime.runCoordinationExecutor.enqueue(first)
      await runtime.runCoordinationExecutor.enqueue(second)

      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-1',
        workflowNames: ['coalesced-workflow'],
        leaseMs: 30_000,
      })
      expect(claimed?.command).toStrictEqual(second)

      await runtime.runCoordinationExecutor.ack(claimed!)
      const empty = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-2',
        workflowNames: ['coalesced-workflow'],
        leaseMs: 30_000,
      })
      expect(empty).toBeNull()
    })

    it('coalesced continue commands keep an immediate wakeup ahead of a delayed wakeup', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'coalesced-delayed-workflow',
        input: {},
      })
      const delayed = {
        kind: 'continueRun' as const,
        runId: run.id,
        workflowName: 'coalesced-delayed-workflow',
        generation: 1,
      }
      const immediate = {
        kind: 'continueRun' as const,
        runId: run.id,
        workflowName: 'coalesced-delayed-workflow',
        generation: 2,
      }

      await runtime.runCoordinationExecutor.enqueueDelayed(
        delayed,
        new Date(Date.now() + 60_000),
      )
      await runtime.runCoordinationExecutor.enqueue(immediate)

      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-1',
        workflowNames: ['coalesced-delayed-workflow'],
        leaseMs: 30_000,
      })
      expect(claimed?.command).toStrictEqual(immediate)
    })

    it('lets a leased continue command coexist with a fresh unclaimed continue', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'leased-continue-workflow',
        input: {},
      })
      const first = {
        kind: 'continueRun' as const,
        runId: run.id,
        workflowName: 'leased-continue-workflow',
        generation: 1,
      }
      const second = {
        kind: 'continueRun' as const,
        runId: run.id,
        workflowName: 'leased-continue-workflow',
        generation: 2,
      }

      await runtime.runCoordinationExecutor.enqueue(first)
      const leased = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-1',
        workflowNames: ['leased-continue-workflow'],
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.enqueue(second)
      const fresh = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-2',
        workflowNames: ['leased-continue-workflow'],
        leaseMs: 30_000,
      })

      expect(leased?.command).toStrictEqual(first)
      expect(fresh?.command).toStrictEqual(second)
      expect(fresh?.id).not.toBe(leased?.id)
    })

    it('dead-letters run coordination commands after max error deliveries and requeues them', async () => {
      const runtime = await createRuntime({ maxDeliveries: 1 })
      const run = await runtime.store.createRun({
        workflowName: 'dead-continue-workflow',
        input: {},
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: run.id,
        workflowName: 'dead-continue-workflow',
      })
      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-1',
        workflowNames: ['dead-continue-workflow'],
        leaseMs: 30_000,
      })

      await runtime.runCoordinationExecutor.release(claimed!, {
        error: new Error('poison continue'),
      })

      const dead = await runtime.store.listDeadCommands()
      expect(dead).toMatchObject([
        {
          kind: 'continue',
          runId: run.id,
          workflowName: 'dead-continue-workflow',
          deliveryCount: 1,
          lastError: { name: 'Error', message: 'poison continue' },
        },
      ])
      expect(dead[0]?.deadAt).toBeInstanceOf(Date)
      await expect(
        runtime.runCoordinationExecutor.claim({
          workerId: 'worker-2',
          workflowNames: ['dead-continue-workflow'],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()

      await runtime.store.requeueDeadCommand(dead[0]!.id)
      await expect(runtime.store.listDeadCommands()).resolves.toStrictEqual([])
      const requeued = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-3',
        workflowNames: ['dead-continue-workflow'],
        leaseMs: 30_000,
      })
      expect(requeued?.command.runId).toBe(run.id)
    })

    it('does not count busy run coordination releases toward dead-letter delivery', async () => {
      const runtime = await createRuntime({ maxDeliveries: 1 })
      const run = await runtime.store.createRun({
        workflowName: 'busy-release-workflow',
        input: {},
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: run.id,
        workflowName: 'busy-release-workflow',
      })
      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-1',
        workflowNames: ['busy-release-workflow'],
        leaseMs: 30_000,
      })

      await runtime.runCoordinationExecutor.release(claimed!)
      await expect(runtime.store.listDeadCommands()).resolves.toStrictEqual([])
      await waitForReleaseBackoff()

      const reclaimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'worker-2',
        workflowNames: ['busy-release-workflow'],
        leaseMs: 30_000,
      })
      expect(reclaimed?.command.runId).toBe(run.id)
    })

    it('dead-letters attempt commands after max error deliveries and requeues them', async () => {
      const runtime = await createRuntime({ maxDeliveries: 1 })
      const run = await runtime.store.createRun({
        workflowName: 'dead-attempt-workflow',
        input: {},
      })
      const command = {
        kind: 'activityAttempt' as const,
        workflowName: 'dead-attempt-workflow',
        activityName: 'content',
        runId: run.id,
        nodeName: 'content',
        childKey: '$self',
        attemptId: '00000000-0000-4000-8000-000000000212',
        leaseToken: 'attempt-lease',
        input: {},
      }
      await runtime.attemptExecutor.dispatchActivity(command)
      const claimed = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-1',
        workflowNames: ['dead-attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })

      await runtime.attemptExecutor.release(claimed!, {
        error: new Error('poison activity command'),
      })

      const dead = await runtime.store.listDeadCommands()
      expect(dead).toMatchObject([
        {
          kind: 'activity',
          runId: run.id,
          workflowName: 'dead-attempt-workflow',
          activityName: 'content',
          attemptId: command.attemptId,
          deliveryCount: 1,
          lastError: { name: 'Error', message: 'poison activity command' },
        },
      ])
      await runtime.store.requeueDeadCommand(dead[0]!.id)
      const requeued = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-2',
        workflowNames: ['dead-attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      expect(requeued?.command).toStrictEqual(command)
    })

    it('prunes old terminal root run trees and associated commands', async () => {
      const runtime = await createRuntime()
      const root = await runtime.store.createRun({
        workflowName: 'pruned-root-workflow',
        input: {},
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'map',
        kind: 'mapTask',
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'content',
        kind: 'activity',
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      const { childRun } = await runtime.store.ensureChildRun({
        runId: root.id,
        nodeName: 'child',
        childKey: '$self',
        childKind: 'workflow',
        childName: 'pruned-child-workflow',
        input: {},
        rootRunId: root.id,
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'map',
        children: [
          { childKey: 'item:0', kind: 'task', ordinal: 0, item: { id: 'a' } },
          { childKey: 'item:1', kind: 'task', ordinal: 1, item: { id: 'b' } },
        ],
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'content',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      const attempt = await runtime.store.createAttempt({
        runId: root.id,
        nodeName: 'content',
        childKey: '$self',
        input: {},
      })
      const lease = await runtime.store.acquireRunLease({
        runId: root.id,
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: root.id,
        workflowName: root.workflowName,
      })
      await runtime.attemptExecutor.dispatchActivity({
        kind: 'activityAttempt',
        workflowName: root.workflowName,
        activityName: 'content',
        runId: root.id,
        nodeName: 'content',
        childKey: '$self',
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        input: {},
      })
      await runtime.store.completeRun({
        runId: childRun.id,
        output: { ok: true },
      })
      await runtime.store.completeRun({ runId: root.id, output: { ok: true } })

      const result = await runtime.store.pruneTerminalRuns({
        olderThan: new Date(Date.now() + 1_000),
        batchSize: 1,
      })

      expect(result).toStrictEqual({ deleted: 1 })
      await expect(
        runtime.store.loadRunSnapshot(root.id),
      ).resolves.toBeUndefined()
      await expect(
        runtime.store.loadRunSnapshot(childRun.id),
      ).resolves.toBeUndefined()
      await expect(
        runtime.runCoordinationExecutor.claim({
          workerId: 'prune-checker',
          workflowNames: [root.workflowName],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
      await expect(
        runtime.attemptExecutor.claim({
          taskNames: [],
          workerId: 'prune-checker',
          workflowNames: [root.workflowName],
          activityNames: ['content'],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
      await expect(
        runtime.store.renewRunLease(lease!, 30_000),
      ).resolves.toBeUndefined()
    })

    it('preserves non-terminal, recent terminal, and terminal child runs during pruning', async () => {
      const runtime = await createRuntime()
      const queuedRoot = await runtime.store.createRun({
        workflowName: 'queued-prune-survivor',
        input: {},
      })
      const recentRoot = await runtime.store.createRun({
        workflowName: 'recent-prune-survivor',
        input: {},
      })
      await runtime.store.completeRun({
        runId: recentRoot.id,
        output: { ok: true },
      })

      await expect(
        runtime.store.pruneTerminalRuns({ olderThan: new Date(0) }),
      ).resolves.toStrictEqual({ deleted: 0 })
      await expect(
        runtime.store.loadRunSnapshot(queuedRoot.id),
      ).resolves.toBeDefined()
      await expect(
        runtime.store.loadRunSnapshot(recentRoot.id),
      ).resolves.toBeDefined()

      const liveParent = await runtime.store.createRun({
        workflowName: 'live-parent-prune-survivor',
        input: {},
      })
      await runtime.store.createNode({
        runId: liveParent.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.ensureNodeChildren({
        runId: liveParent.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      const { childRun } = await runtime.store.ensureChildRun({
        runId: liveParent.id,
        nodeName: 'child',
        childKey: '$self',
        childKind: 'workflow',
        childName: 'terminal-child-prune-survivor',
        input: {},
        rootRunId: liveParent.id,
      })
      await runtime.store.completeRun({
        runId: childRun.id,
        output: { ok: true },
      })

      await expect(
        runtime.store.pruneTerminalRuns({
          olderThan: new Date(Date.now() + 1_000),
        }),
      ).resolves.toStrictEqual({ deleted: 1 })
      await expect(
        runtime.store.loadRunSnapshot(liveParent.id),
      ).resolves.toBeDefined()
      await expect(
        runtime.store.loadRunSnapshot(childRun.id),
      ).resolves.toBeDefined()
    })

    it('loads run rows in batch, skipping unknown ids', async () => {
      const runtime = await createRuntime()
      const first = await runtime.store.createRun({
        workflowName: 'batch-load-workflow',
        input: { index: 1 },
      })
      const second = await runtime.store.createRun({
        workflowName: 'batch-load-workflow',
        input: { index: 2 },
      })
      const missingUuid = '00000000-0000-4000-8000-000000000000'

      const loaded = await runtime.store.loadRuns([
        second.id,
        missingUuid,
        first.id,
        second.id,
        'missing-run-id',
      ])

      expect(loaded.map((run) => run.id)).toStrictEqual([second.id, first.id])
      await expect(runtime.store.loadRuns([])).resolves.toStrictEqual([])
      await expect(
        runtime.store.loadRuns([missingUuid, 'missing-run-id']),
      ).resolves.toStrictEqual([])
    })

    it('watch yields run status transitions and ends at terminal', async () => {
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const run = await runtime.store.createRun({
        workflowName: 'watch-status-workflow',
        input: {},
      })
      const iterator = client
        .watch(run.id, { pollIntervalMs: 10 })
        [Symbol.asyncIterator]()
      try {
        expect((await iterator.next()).value).toStrictEqual({
          kind: 'run',
          status: 'queued',
        })
        await runtime.store.markRunRunning({ runId: run.id })
        expect((await iterator.next()).value).toStrictEqual({
          kind: 'run',
          status: 'running',
        })
        await runtime.store.failRun({
          runId: run.id,
          error: new Error('watch me fail'),
        })
        const terminal = (await iterator.next()).value
        expect(terminal).toMatchObject({ kind: 'run', status: 'failed' })
        expect(
          terminal && 'error' in terminal ? terminal.error?.message : undefined,
        ).toBe('watch me fail')
        expect((await iterator.next()).done).toBe(true)
      } finally {
        await iterator.return?.()
      }
    })

    it('watch with wake yields coarse change events for family transitions', async () => {
      const runtime = await createRuntime()
      // coarse events are NOTIFY-only; adapters without a wake hub are
      // covered by the integration suite instead
      if (!runtime.wakeEvents) return
      const client = createWorkflowRuntimeClient(runtime)
      const run = await runtime.store.createRun({
        workflowName: 'watch-wake-workflow',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'step',
        kind: 'activity',
      })
      // a huge poll interval proves every yield below is wake-driven
      const iterator = client
        .watch(run.id, { wake: true, pollIntervalMs: 60_000 })
        [Symbol.asyncIterator]()
      try {
        expect((await iterator.next()).value).toStrictEqual({
          kind: 'run',
          status: 'queued',
        })
        // node-level transition leaves the run row untouched — without the
        // wake option this signal would be swallowed
        await runtime.store.ensureNodeChildren({
          runId: run.id,
          nodeName: 'step',
          children: [{ childKey: '$self', kind: 'activity' }],
        })
        await runtime.store.ensureChildAttempt({
          runId: run.id,
          nodeName: 'step',
          childKey: '$self',
          input: {},
        })
        expect((await iterator.next()).value).toStrictEqual({ kind: 'change' })
        await runtime.store.markRunRunning({ runId: run.id })
        expect((await iterator.next()).value).toStrictEqual({
          kind: 'run',
          status: 'running',
        })
        await runtime.store.completeRun({ runId: run.id, output: {} })
        expect((await iterator.next()).value).toStrictEqual({
          kind: 'run',
          status: 'completed',
        })
        expect((await iterator.next()).done).toBe(true)
      } finally {
        await iterator.return?.()
      }
    })

    it('sweeps old dead commands during pruning', async () => {
      const runtime = await createRuntime({ maxDeliveries: 1 })
      const run = await runtime.store.createRun({
        workflowName: 'dead-command-sweep-workflow',
        input: {},
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: run.id,
        workflowName: run.workflowName,
      })
      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'dead-command-sweeper',
        workflowNames: [run.workflowName],
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.release(claimed!, {
        error: new Error('dead command'),
      })
      await expect(runtime.store.listDeadCommands()).resolves.toHaveLength(1)

      await expect(
        runtime.store.pruneTerminalRuns({
          olderThan: new Date(Date.now() + 1_000),
          statuses: [],
        }),
      ).resolves.toStrictEqual({ deleted: 0 })
      await expect(runtime.store.listDeadCommands()).resolves.toStrictEqual([])
      await expect(runtime.store.loadRunSnapshot(run.id)).resolves.toBeDefined()
    })

    it('batches store pruning and drains via the runtime client helper', async () => {
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const runs = await Promise.all(
        Array.from({ length: 5 }, async (_, index) => {
          const run = await runtime.store.createRun({
            workflowName: 'batched-prune-workflow',
            input: { index },
          })
          await runtime.store.completeRun({
            runId: run.id,
            output: { index },
          })
          return run
        }),
      )
      const olderThan = new Date(Date.now() + 1_000)

      await expect(
        runtime.store.pruneTerminalRuns({ olderThan, batchSize: 2 }),
      ).resolves.toStrictEqual({ deleted: 2 })
      await expect(
        client.pruneRuns({ olderThan, batchSize: 2 }),
      ).resolves.toStrictEqual({ deleted: 3 })
      await expect(
        runtime.store.listRuns({ name: 'batched-prune-workflow' }),
      ).resolves.toStrictEqual({ runs: [] })
      expect(runs).toHaveLength(5)
    })

    it('returns not deleted when deleting an unknown run', async () => {
      const runtime = await createRuntime()

      await expect(
        runtime.store.deleteRun('missing-run-id'),
      ).resolves.toStrictEqual({ deleted: false })
      await expect(
        runtime.store.deleteRun('00000000-0000-4000-8000-000000000000'),
      ).resolves.toStrictEqual({ deleted: false })
    })

    it('refuses to delete child runs directly', async () => {
      const runtime = await createRuntime()
      const root = await runtime.store.createRun({
        workflowName: 'delete-child-root',
        input: {},
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      const { childRun } = await runtime.store.ensureChildRun({
        runId: root.id,
        nodeName: 'child',
        childKey: '$self',
        childKind: 'workflow',
        childName: 'delete-child-member',
        input: {},
        rootRunId: root.id,
      })

      await expect(runtime.store.deleteRun(childRun.id)).rejects.toThrow(
        `Run [${childRun.id}] is not a root run`,
      )
    })

    it('refuses to delete run families with non-terminal members', async () => {
      const runtime = await createRuntime()
      const root = await runtime.store.createRun({
        workflowName: 'delete-live-family-root',
        input: {},
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      const { childRun } = await runtime.store.ensureChildRun({
        runId: root.id,
        nodeName: 'child',
        childKey: '$self',
        childKind: 'workflow',
        childName: 'delete-live-family-child',
        input: {},
        rootRunId: root.id,
      })
      await runtime.store.completeRun({ runId: root.id, output: { ok: true } })

      await expect(runtime.store.deleteRun(root.id)).rejects.toThrow(
        `Run [${root.id}] has non-terminal runs`,
      )
      await expect(
        runtime.store.loadRunSnapshot(root.id),
      ).resolves.toBeDefined()
      await expect(
        runtime.store.loadRunSnapshot(childRun.id),
      ).resolves.toBeDefined()
    })

    it('refuses to delete parent-linked descendants missing the root id', async () => {
      const runtime = await createRuntime()
      const root = await runtime.store.createRun({
        workflowName: 'delete-parent-link-root',
        input: {},
      })
      const child = await runtime.store.createRun({
        workflowName: 'delete-parent-link-child',
        input: {},
        parentRunId: root.id,
      })
      await runtime.store.markRunRunning({ runId: child.id })
      await runtime.store.completeRun({ runId: root.id, output: { ok: true } })

      await expect(runtime.store.deleteRun(root.id)).rejects.toThrow(
        `Run [${root.id}] has non-terminal runs`,
      )
      await expect(
        runtime.store.loadRunSnapshot(child.id),
      ).resolves.toBeDefined()

      await runtime.store.completeRun({ runId: child.id, output: { ok: true } })

      await expect(runtime.store.deleteRun(root.id)).resolves.toStrictEqual({
        deleted: true,
      })
      await expect(
        runtime.store.loadRunSnapshot(root.id),
      ).resolves.toBeUndefined()
      await expect(
        runtime.store.loadRunSnapshot(child.id),
      ).resolves.toBeUndefined()
    })

    it('deletes terminal root run families and associated commands', async () => {
      const runtime = await createRuntime({ maxDeliveries: 1 })
      const root = await runtime.store.createRun({
        workflowName: 'deleted-root-workflow',
        input: {},
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'content',
        kind: 'activity',
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      const { childRun } = await runtime.store.ensureChildRun({
        runId: root.id,
        nodeName: 'child',
        childKey: '$self',
        childKind: 'workflow',
        childName: 'deleted-child-workflow',
        input: {},
        rootRunId: root.id,
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'content',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      const attempt = await runtime.store.createAttempt({
        runId: root.id,
        nodeName: 'content',
        childKey: '$self',
        input: {},
      })
      const lease = await runtime.store.acquireRunLease({
        runId: root.id,
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: root.id,
        workflowName: root.workflowName,
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: childRun.id,
        workflowName: childRun.workflowName,
      })
      await runtime.attemptExecutor.dispatchActivity({
        kind: 'activityAttempt',
        workflowName: root.workflowName,
        activityName: 'content',
        runId: root.id,
        nodeName: 'content',
        childKey: '$self',
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        input: {},
      })
      const claimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'delete-dead-letterer',
        workflowNames: [root.workflowName],
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.release(claimed!, {
        error: new Error('delete dead command'),
      })
      const childClaimed = await runtime.runCoordinationExecutor.claim({
        workerId: 'delete-child-dead-letterer',
        workflowNames: [childRun.workflowName],
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.release(childClaimed!, {
        error: new Error('delete child dead command'),
      })
      await runtime.store.completeRun({
        runId: childRun.id,
        output: { ok: true },
      })
      await runtime.store.completeRun({ runId: root.id, output: { ok: true } })

      await expect(
        runtime.store.listDeadCommands({ runId: root.id }),
      ).resolves.toHaveLength(1)
      await expect(
        runtime.store.listDeadCommands({ runId: childRun.id }),
      ).resolves.toHaveLength(1)
      await expect(runtime.store.deleteRun(root.id)).resolves.toStrictEqual({
        deleted: true,
      })
      await expect(
        runtime.store.loadRunSnapshot(root.id),
      ).resolves.toBeUndefined()
      await expect(
        runtime.store.loadRunSnapshot(childRun.id),
      ).resolves.toBeUndefined()
      await expect(
        runtime.store.listDeadCommands({ runId: root.id }),
      ).resolves.toStrictEqual([])
      await expect(
        runtime.store.listDeadCommands({ runId: childRun.id }),
      ).resolves.toStrictEqual([])
      await expect(
        runtime.runCoordinationExecutor.claim({
          workerId: 'delete-root-checker',
          workflowNames: [childRun.workflowName],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
      await expect(
        runtime.attemptExecutor.claim({
          taskNames: [],
          workerId: 'delete-attempt-checker',
          workflowNames: [root.workflowName],
          activityNames: ['content'],
          leaseMs: 30_000,
        }),
      ).resolves.toBeNull()
      await expect(
        runtime.store.renewRunLease(lease!, 30_000),
      ).resolves.toBeUndefined()
    })

    it('filters dead commands by run id', async () => {
      const runtime = await createRuntime({ maxDeliveries: 1 })
      const client = createWorkflowRuntimeClient(runtime)
      const first = await runtime.store.createRun({
        workflowName: 'filtered-dead-command-workflow-first',
        input: { index: 1 },
      })
      const second = await runtime.store.createRun({
        workflowName: 'filtered-dead-command-workflow-second',
        input: { index: 2 },
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: first.id,
        workflowName: first.workflowName,
      })
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: second.id,
        workflowName: second.workflowName,
      })

      const firstClaim = await runtime.runCoordinationExecutor.claim({
        workerId: 'dead-filter-worker-1',
        workflowNames: [first.workflowName],
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.release(firstClaim!, {
        error: new Error('first dead command'),
      })
      const secondClaim = await runtime.runCoordinationExecutor.claim({
        workerId: 'dead-filter-worker-2',
        workflowNames: [second.workflowName],
        leaseMs: 30_000,
      })
      await runtime.runCoordinationExecutor.release(secondClaim!, {
        error: new Error('second dead command'),
      })

      await expect(runtime.store.listDeadCommands()).resolves.toHaveLength(2)
      await expect(
        runtime.store.listDeadCommands({ runId: first.id }),
      ).resolves.toMatchObject([
        {
          kind: 'continue',
          runId: first.id,
          lastError: { message: 'first dead command' },
        },
      ])
      await expect(
        client.listDeadCommands({ runId: second.id }),
      ).resolves.toMatchObject([
        {
          kind: 'continue',
          runId: second.id,
          lastError: { message: 'second dead command' },
        },
      ])
    })

    it('threads worker continuation errors into dead-letter metadata', async () => {
      const workflow = defineWorkflow({
        name: 'poison-worker-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ ok: t.boolean() }),
      })
        .activity('content', {
          input: t.object({ scenario: t.string() }),
          output: t.object({ ok: t.boolean() }),
        })
        .build()
      const implementation = implementWorkflow(workflow)
        .content(async () => ({ ok: true }))
        .finish((_ctx, { content }) => content)
      const runtime = await createRuntime({ maxDeliveries: 1 })
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, { scenario: 'alpha' })

      await expect(
        runWorkflowWorker({
          ...runtime,
          attemptExecutor: {
            ...runtime.attemptExecutor,
            dispatchActivity: async () => {
              throw new Error('poison worker continue')
            },
          },
          atomicContinuation: undefined,
          container: testContainer,
          workflows: [implementation],
          workerId: 'poison-worker-1',
        }),
      ).rejects.toThrow('poison worker continue')

      await expect(runtime.store.listDeadCommands()).resolves.toMatchObject([
        {
          kind: 'continue',
          runId: run.id,
          deliveryCount: 1,
          lastError: { name: 'Error', message: 'poison worker continue' },
        },
      ])
    })

    it('claims, heartbeats, acks, and releases attempt commands', async () => {
      const runtime = await createRuntime()
      const activityRun = await runtime.store.createRun({
        workflowName: 'attempt-workflow',
        input: {},
      })
      const taskRun = await runtime.store.createRun({
        kind: 'task',
        name: 'embedding',
        workflowName: 'attempt-task',
        taskName: 'embedding',
        input: {},
      })
      const activityCommand = {
        kind: 'activityAttempt' as const,
        workflowName: 'attempt-workflow',
        activityName: 'content',
        runId: activityRun.id,
        nodeName: 'content',
        childKey: '$self',
        attemptId: '00000000-0000-4000-8000-000000000202',
        leaseToken: 'lease-activity',
        input: { scenario: 'alpha' },
      }
      const taskCommand = {
        kind: 'taskAttempt' as const,
        workflowName: 'attempt-task',
        taskName: 'embedding',
        runId: taskRun.id,
        nodeName: '$task',
        childKey: '$self',
        attemptId: '00000000-0000-4000-8000-000000000204',
        leaseToken: 'lease-task',
        input: { text: 'alpha' },
      }

      await runtime.attemptExecutor.dispatchActivity(activityCommand)
      await runtime.attemptExecutor.dispatchTask(taskCommand)

      const wrongWorkflow = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-1',
        workflowNames: ['other-workflow'],
        leaseMs: 30_000,
      })
      const wrongActivity = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-1',
        workflowNames: ['attempt-workflow'],
        activityNames: ['other-activity'],
        leaseMs: 30_000,
      })
      const activity = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-1',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      const noneWhileActivityClaimed = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-2',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })

      expect(wrongWorkflow).toBeNull()
      expect(wrongActivity).toBeNull()
      expect(activity?.command).toStrictEqual(activityCommand)
      expect(noneWhileActivityClaimed).toBeNull()

      await expect(
        runtime.attemptExecutor.heartbeat(activity!),
      ).resolves.toStrictEqual({ runStatus: 'queued' })
      await runtime.store.requestRunCancellation({ runId: activityRun.id })
      await expect(
        runtime.attemptExecutor.heartbeat(activity!),
      ).resolves.toStrictEqual({ runStatus: 'cancelling' })
      await expect(
        runtime.attemptExecutor.heartbeat({
          ...activity!,
          leaseToken: 'stale-attempt-lease',
        }),
      ).rejects.toThrow('Workflow attempt heartbeat lease lost')
      await runtime.attemptExecutor.release(activity!)

      const activityBeforeBackoff = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-2',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      expect(activityBeforeBackoff).toBeNull()

      await waitForReleaseBackoff()

      const reclaimedActivity = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-2',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      expect(reclaimedActivity?.command).toStrictEqual(activityCommand)

      await runtime.attemptExecutor.ack(reclaimedActivity!)

      const activityAfterAck = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-3',
        workflowNames: ['attempt-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      expect(activityAfterAck).toBeNull()

      const wrongTask = await runtime.attemptExecutor.claim({
        workflowNames: [],
        activityNames: [],
        workerId: 'task-worker-1',
        taskNames: ['other-task'],
        leaseMs: 30_000,
      })
      const task = await runtime.attemptExecutor.claim({
        workflowNames: [],
        activityNames: [],
        workerId: 'task-worker-1',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })

      expect(wrongTask).toBeNull()
      expect(task?.command).toStrictEqual(taskCommand)
      await expect(
        runtime.attemptExecutor.heartbeat(task!),
      ).resolves.toStrictEqual({ runStatus: 'queued' })

      await runtime.attemptExecutor.release(task!)

      const taskBeforeBackoff = await runtime.attemptExecutor.claim({
        workflowNames: [],
        activityNames: [],
        workerId: 'task-worker-2',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })
      expect(taskBeforeBackoff).toBeNull()

      await waitForReleaseBackoff()

      const reclaimedTask = await runtime.attemptExecutor.claim({
        workflowNames: [],
        activityNames: [],
        workerId: 'task-worker-2',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })
      expect(reclaimedTask?.command).toStrictEqual(taskCommand)

      await runtime.attemptExecutor.ack(reclaimedTask!)

      const taskAfterAck = await runtime.attemptExecutor.claim({
        workflowNames: [],
        activityNames: [],
        workerId: 'task-worker-3',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })
      expect(taskAfterAck).toBeNull()
    })

    it('claims activities and tasks from one globally ordered queue', async () => {
      const runtime = await createRuntime()
      const taskRun = await runtime.store.createRun({
        kind: 'task',
        name: 'ordered-task',
        workflowName: 'ordered-task',
        taskName: 'ordered-task',
        input: {},
      })
      const activityRun = await runtime.store.createRun({
        workflowName: 'ordered-workflow',
        input: {},
      })
      const taskCommand = {
        kind: 'taskAttempt' as const,
        workflowName: 'ordered-task',
        taskName: 'ordered-task',
        runId: taskRun.id,
        nodeName: '$task',
        childKey: '$self',
        attemptId: '00000000-0000-4000-8000-000000000211',
        leaseToken: 'task-lease',
        input: {},
      }
      const activityCommand = {
        kind: 'activityAttempt' as const,
        workflowName: 'ordered-workflow',
        activityName: 'ordered-activity',
        runId: activityRun.id,
        nodeName: 'ordered-activity',
        childKey: '$self',
        attemptId: '00000000-0000-4000-8000-000000000212',
        leaseToken: 'activity-lease',
        input: {},
      }

      const firstRunAt = new Date(Date.now() - 2)
      await runtime.attemptExecutor.dispatchTask(taskCommand, {
        runAt: firstRunAt,
      })
      await runtime.attemptExecutor.dispatchActivity(activityCommand, {
        runAt: new Date(firstRunAt.getTime() + 1),
      })

      const selectors = {
        workflowNames: ['ordered-workflow'],
        activityNames: ['ordered-activity'],
        taskNames: ['ordered-task'],
        leaseMs: 30_000,
      }
      const first = await runtime.attemptExecutor.claim({
        ...selectors,
        workerId: 'execution-worker-1',
      })
      const second = await runtime.attemptExecutor.claim({
        ...selectors,
        workerId: 'execution-worker-1',
      })

      expect(first?.command).toStrictEqual(taskCommand)
      expect(second?.command).toStrictEqual(activityCommand)
      await runtime.attemptExecutor.ack(first!)
      await runtime.attemptExecutor.ack(second!)
    })

    it('leases one coordinator per run and ignores stale lease release', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'lease-workflow',
        input: {},
      })
      const missing = await runtime.store.acquireRunLease({
        runId: 'missing-run',
        leaseMs: 30_000,
      })

      const expired = await runtime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 0,
      })
      const current = await runtime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 30_000,
      })
      const busy = await runtime.store.acquireRunLease({
        runId: run.id,
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
        leaseMs: 30_000,
      })
      expect(stillBusy).toBeUndefined()

      await runtime.store.releaseRunLease(current!)

      const next = await runtime.store.acquireRunLease({
        runId: run.id,
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

      const jsonbOrdered = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'jsonb-idempotent-workflow',
        input: { currency: 'USD', amount: 5 },
        idempotencyKey: ['workflow', 'jsonb-order'],
      })
      const sameJsonbOrdered = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'jsonb-idempotent-workflow',
        input: { currency: 'USD', amount: 5 },
        idempotencyKey: ['workflow', 'jsonb-order'],
      })

      expect(sameJsonbOrdered.id).toBe(jsonbOrdered.id)

      const stableKeyed = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'stable-json-idempotent-workflow',
        input: { currency: 'USD', amount: 5 },
        idempotencyKey: ['workflow', { scenario: 'alpha', rank: 1 }],
      })
      const sameStableKeyed = await runtime.store.createRun({
        kind: 'workflow',
        workflowName: 'stable-json-idempotent-workflow',
        input: { amount: 5, currency: 'USD' },
        idempotencyKey: ['workflow', { rank: 1, scenario: 'alpha' }],
      })

      expect(sameStableKeyed.id).toBe(stableKeyed.id)

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
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'content',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'late',
        kind: 'activity',
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'late',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      await runtime.store.completeNodeChild({
        runId: run.id,
        nodeName: 'late',
        childKey: '$self',
        output: { ok: true },
      })
      const firstAttempt = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: '$self',
        input: { value: 1 },
      })
      const secondAttempt = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: '$self',
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
      const { children: settledChildren } =
        await runtime.store.loadNodeChildren({
          runId: run.id,
          nodeName: 'content',
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
      const inputAfterTerminal = await runtime.store.setNodeInput({
        runId: run.id,
        nodeName: 'content',
        input: { text: 'too-late' },
      })
      const selectedAfterTerminal = await runtime.store.selectNodeCase({
        runId: run.id,
        nodeName: 'content',
        caseKey: 'too-late',
      })
      const waitedAfterTerminal = await runtime.store.waitNode({
        runId: run.id,
        nodeName: 'content',
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
      const cancelledRun = await runtime.store.cancelRun({
        runId: run.id,
      })
      await expect(
        runtime.store.createAttempt({
          runId: run.id,
          nodeName: 'content',
          childKey: '$self',
          input: { text: 'too-late' },
        }),
      ).rejects.toThrow(/terminal/i)
      await expect(
        runtime.store.ensureChildAttempt({
          runId: run.id,
          nodeName: 'late',
          childKey: '$self',
          input: { text: 'too-late' },
        }),
      ).rejects.toThrow(/terminal/i)
      const replayedAttempt = await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: '$self',
        input: { text: 'too-late' },
      })

      expect(stale).toBeUndefined()
      expect(wrongToken).toBeUndefined()
      expect(completed?.output).toStrictEqual({ text: 'fresh' })
      expect(settledChildren).toMatchObject([
        { childKey: '$self', status: 'completed', output: { text: 'fresh' } },
      ])
      expect(replayedAttempt.created).toBe(false)
      expect(replayedAttempt.attempt.id).toBe(secondAttempt.id)
      expect(duplicate).toBeUndefined()
      expect(failAfterComplete).toBeUndefined()
      expect(completedNode?.status).toBe('completed')
      expect(inputAfterTerminal.status).toBe('completed')
      expect(inputAfterTerminal.input).toBeUndefined()
      expect(selectedAfterTerminal?.status).toBe('completed')
      expect(selectedAfterTerminal?.selectedCase).toBeUndefined()
      expect(waitedAfterTerminal?.status).toBe('completed')
      expect(failedNode?.status).toBe('completed')
      expect(failedNode?.output).toStrictEqual({ text: 'node' })
      expect(completedRun?.status).toBe('completed')
      expect(failedRun?.status).toBe('completed')
      expect(failedRun?.output).toStrictEqual({ ok: true })
      expect(cancelledRun?.status).toBe('completed')
      expect(cancelledRun?.output).toStrictEqual({ ok: true })
    })

    it('records timed-out current attempts and ignores stale timeout writes', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'timeout-store-workflow',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'content',
        kind: 'activity',
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'content',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      const firstAttempt = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: '$self',
        input: { value: 1 },
      })
      const secondAttempt = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'content',
        childKey: '$self',
        input: { value: 2 },
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
      const duplicate = await runtime.store.timeoutCurrentAttempt({
        attemptId: secondAttempt.id,
        leaseToken: secondAttempt.leaseToken!,
        error: new Error('duplicate timeout'),
      })
      const failAfterTimeout = await runtime.store.failCurrentAttempt({
        attemptId: secondAttempt.id,
        leaseToken: secondAttempt.leaseToken!,
        error: new Error('too late'),
      })

      expect(stale).toBeUndefined()
      expect(wrongToken).toBeUndefined()
      expect(timedOut?.status).toBe('timedOut')
      expect(timedOut?.error?.message).toBe('fresh timeout')
      expect(duplicate).toBeUndefined()
      expect(failAfterTimeout).toBeUndefined()
      // Timeouts settle only the attempt; the child stays open for a retry.
      const { children } = await runtime.store.loadNodeChildren({
        runId: run.id,
        nodeName: 'content',
      })
      expect(children).toMatchObject([
        { childKey: '$self', status: 'running', attemptCount: 2 },
      ])
    })

    it('cancels a non-terminal run', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'cancelled-workflow',
        input: {},
      })

      const cancelled = await runtime.store.cancelRun({
        runId: run.id,
      })
      const completedAfterCancel = await runtime.store.completeRun({
        runId: run.id,
        output: { ok: true },
      })
      const failedAfterCancel = await runtime.store.failRun({
        runId: run.id,
        error: new Error('too-late'),
      })

      expect(cancelled?.status).toBe('cancelled')
      expect(completedAfterCancel?.status).toBe('cancelled')
      expect(failedAfterCancel?.status).toBe('cancelled')
    })

    it('requests cancellation before final cancellation', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'requested-cancel-workflow',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'first',
        kind: 'activity',
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'second',
        kind: 'activity',
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'first',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'second',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      await runtime.store.completeNodeChild({
        runId: run.id,
        nodeName: 'first',
        childKey: '$self',
        output: { ok: true },
      })
      await runtime.store.completeNode({
        runId: run.id,
        nodeName: 'first',
        output: { ok: true },
      })

      const requested = await runtime.store.requestRunCancellation({
        runId: run.id,
      })
      const cancelledNode = await runtime.store.cancelNode({
        runId: run.id,
        nodeName: 'second',
      })
      await runtime.store.cancelNonTerminalRunNodes({ runId: run.id })
      const final = await runtime.store.cancelRun({ runId: run.id })
      const snapshot = await runtime.store.loadRunSnapshot(run.id)

      expect(requested?.status).toBe('cancelling')
      expect(cancelledNode?.status).toBe('cancelled')
      expect(final?.status).toBe('cancelled')
      expect(snapshot?.nodes.map((node) => [node.name, node.status])).toEqual([
        ['first', 'completed'],
        ['second', 'cancelled'],
      ])
      // The sweep cancels open child rows too, but never rewrites settled ones.
      expect(
        snapshot?.children
          .map((child) => [child.nodeName, child.status])
          .sort(),
      ).toEqual([
        ['first', 'completed'],
        ['second', 'cancelled'],
      ])
    })

    it('deletes only unclaimed attempt commands for a run', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'delete-unclaimed-workflow',
        input: {},
      })
      const otherRun = await runtime.store.createRun({
        workflowName: 'delete-unclaimed-workflow',
        input: {},
      })
      const command = (runId: string, attemptId: string) => ({
        kind: 'activityAttempt' as const,
        workflowName: 'delete-unclaimed-workflow',
        activityName: 'content',
        runId,
        nodeName: 'content',
        childKey: '$self',
        attemptId,
        leaseToken: `lease-${attemptId}`,
        input: {},
      })
      const firstRunAt = new Date(Date.now() - 1_000)

      await runtime.attemptExecutor.dispatchActivity(
        command(run.id, '00000000-0000-4000-8000-000000000301'),
        { runAt: firstRunAt },
      )
      await runtime.attemptExecutor.dispatchActivity(
        command(run.id, '00000000-0000-4000-8000-000000000302'),
        { runAt: new Date(firstRunAt.getTime() + 1) },
      )
      await runtime.attemptExecutor.dispatchActivity(
        command(otherRun.id, '00000000-0000-4000-8000-000000000303'),
        { runAt: new Date(firstRunAt.getTime() + 2) },
      )
      const claimed = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-1',
        workflowNames: ['delete-unclaimed-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })

      const deleted = await runtime.attemptExecutor.deleteUnclaimed({
        runId: run.id,
      })
      const remainingClaim = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-2',
        workflowNames: ['delete-unclaimed-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      await runtime.attemptExecutor.ack(claimed!)
      await runtime.attemptExecutor.ack(remainingClaim!)
      const emptyClaim = await runtime.attemptExecutor.claim({
        taskNames: [],
        workerId: 'activity-worker-3',
        workflowNames: ['delete-unclaimed-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })

      expect(claimed?.command.runId).toBe(run.id)
      expect(deleted).toBe(1)
      expect(remainingClaim?.command.runId).toBe(otherRun.id)
      expect(emptyClaim).toBeNull()
    })

    it('ensures node child sets idempotently and rejects conflicting sets', async () => {
      const runtime = await createRuntime()
      const parent = await runtime.store.createRun({
        workflowName: 'parent',
        input: { scenario: 'alpha' },
      })
      await runtime.store.createNode({
        runId: parent.id,
        name: 'items',
        kind: 'mapTask',
      })
      await runtime.store.createNode({
        runId: parent.id,
        name: 'keyless-items',
        kind: 'mapTask',
      })
      const itemChildren = [
        {
          childKey: 'item:0',
          kind: 'task' as const,
          ordinal: 0,
          itemKey: 'one',
          item: { id: 1 },
        },
        {
          childKey: 'item:1',
          kind: 'task' as const,
          ordinal: 1,
          itemKey: 'two',
          item: { id: 2 },
        },
      ]

      const firstItems = await runtime.store.ensureNodeChildren({
        runId: parent.id,
        nodeName: 'items',
        children: itemChildren,
      })
      const sameItems = await runtime.store.ensureNodeChildren({
        runId: parent.id,
        nodeName: 'items',
        children: itemChildren,
      })
      const firstKeylessItems = await runtime.store.ensureNodeChildren({
        runId: parent.id,
        nodeName: 'keyless-items',
        children: [
          {
            childKey: 'item:0',
            kind: 'task',
            ordinal: 0,
            item: { currency: 'USD', amount: 5 },
          },
        ],
      })
      const sameKeylessItems = await runtime.store.ensureNodeChildren({
        runId: parent.id,
        nodeName: 'keyless-items',
        children: [
          {
            childKey: 'item:0',
            kind: 'task',
            ordinal: 0,
            item: { amount: 5, currency: 'USD' },
          },
        ],
      })

      expect(firstItems.created).toBe(true)
      expect(firstItems.children).toMatchObject([
        {
          runId: parent.id,
          nodeName: 'items',
          childKey: 'item:0',
          kind: 'task',
          status: 'pending',
          ordinal: 0,
          itemKey: 'one',
          item: { id: 1 },
          attemptCount: 0,
        },
        {
          childKey: 'item:1',
          status: 'pending',
          ordinal: 1,
          itemKey: 'two',
          item: { id: 2 },
        },
      ])
      expect(sameItems.created).toBe(false)
      expect(sameItems.children).toStrictEqual(firstItems.children)
      expect(firstKeylessItems.created).toBe(true)
      expect(firstKeylessItems.children[0]?.itemKey).toBeUndefined()
      expect(sameKeylessItems.created).toBe(false)
      expect(sameKeylessItems.children).toStrictEqual(
        firstKeylessItems.children,
      )
      // Re-entry with a differing set is a definition conflict, not a merge.
      await expect(
        runtime.store.ensureNodeChildren({
          runId: parent.id,
          nodeName: 'items',
          children: [itemChildren[0]!],
        }),
      ).rejects.toThrow('Conflicting node children')
      await expect(
        runtime.store.ensureNodeChildren({
          runId: parent.id,
          nodeName: 'items',
          children: [
            itemChildren[0]!,
            { ...itemChildren[1]!, item: { id: 999 } },
          ],
        }),
      ).rejects.toThrow('Conflicting node children')
      await expect(
        runtime.store.ensureNodeChildren({
          runId: parent.id,
          nodeName: 'items',
          children: [
            itemChildren[0]!,
            { ...itemChildren[1]!, childKey: 'item:2' },
          ],
        }),
      ).rejects.toThrow('Conflicting node children')
      await expect(
        runtime.store.ensureNodeChildren({
          runId: parent.id,
          nodeName: 'missing-node',
          children: [itemChildren[0]!],
        }),
      ).rejects.toThrow('Missing node')
    })

    it('links child runs to node children once and rejects conflicts', async () => {
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
      const childParams = {
        runId: parent.id,
        nodeName: 'child',
        childKey: '$self',
        childKind: 'workflow' as const,
        childName: 'child',
        input: { scenario: 'alpha' },
        rootRunId: parent.rootRunId,
      }

      // The child record is the anchor; a run cannot be linked before it exists.
      await expect(runtime.store.ensureChildRun(childParams)).rejects.toThrow(
        'Missing node child',
      )

      await runtime.store.ensureNodeChildren({
        runId: parent.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      const firstChild = await runtime.store.ensureChildRun(childParams)
      const sameChild = await runtime.store.ensureChildRun(childParams)

      expect(firstChild.created).toBe(true)
      expect(firstChild.child).toMatchObject({
        childKey: '$self',
        status: 'running',
        childRunId: firstChild.childRun.id,
      })
      expect(firstChild.childRun).toMatchObject({
        kind: 'workflow',
        name: 'child',
        status: 'queued',
        input: { scenario: 'alpha' },
        parentRunId: parent.id,
        parentNodeName: 'child',
        rootRunId: parent.rootRunId,
      })
      expect(sameChild.created).toBe(false)
      expect(sameChild.childRun.id).toBe(firstChild.childRun.id)
      expect(sameChild.child.childRunId).toBe(firstChild.childRun.id)
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
    })

    it('refuses to start a child run on a terminal child record', async () => {
      const runtime = await createRuntime()
      const parent = await runtime.store.createRun({
        workflowName: 'terminal-child-parent',
        input: { scenario: 'alpha' },
      })
      await runtime.store.createNode({
        runId: parent.id,
        name: 'child',
        kind: 'workflow',
      })
      await runtime.store.ensureNodeChildren({
        runId: parent.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      await runtime.store.cancelNonTerminalRunNodes({ runId: parent.id })

      // A cancelled child must not be resurrected into a fresh child run.
      await expect(
        runtime.store.ensureChildRun({
          runId: parent.id,
          nodeName: 'child',
          childKey: '$self',
          childKind: 'workflow',
          childName: 'child',
          input: { scenario: 'alpha' },
          rootRunId: parent.rootRunId,
        }),
      ).rejects.toThrow('Terminal node child')
      const children = await runtime.store.loadNodeChildren({
        runId: parent.id,
        nodeName: 'child',
      })
      expect(children.children[0]).toMatchObject({
        status: 'cancelled',
      })
      expect(children.children[0]?.childRunId).toBeUndefined()
    })

    it('preserves JSON null map item payloads', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'null-item-map',
        input: { scenario: 'alpha' },
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'items',
        kind: 'mapTask',
      })
      const ensured = await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'items',
        children: [
          { childKey: 'item:0', kind: 'task', ordinal: 0, item: null },
          { childKey: 'item:1', kind: 'task', ordinal: 1, item: { id: 1 } },
        ],
      })

      // JSON null is a legitimate item value and must survive the round
      // trip identically on both adapters (SQL NULL must not swallow it).
      expect(ensured.children[0]?.item).toBeNull()
      expect(ensured.children[1]?.item).toStrictEqual({ id: 1 })
      const loaded = await runtime.store.loadNodeChildren({
        runId: run.id,
        nodeName: 'items',
      })
      expect(loaded.children[0]?.item).toBeNull()
      const replay = await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'items',
        children: [
          { childKey: 'item:0', kind: 'task', ordinal: 0, item: null },
          { childKey: 'item:1', kind: 'task', ordinal: 1, item: { id: 1 } },
        ],
      })
      expect(replay.created).toBe(false)
    })

    it('filters runs by creation cutoff for the timeout sweep', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'cutoff-workflow',
        input: { scenario: 'alpha' },
      })

      const before = await runtime.store.listRuns({
        name: 'cutoff-workflow',
        createdBefore: new Date(run.createdAt.getTime() + 1),
      })
      expect(before.runs.map((row) => row.id)).toStrictEqual([run.id])

      const after = await runtime.store.listRuns({
        name: 'cutoff-workflow',
        createdBefore: run.createdAt,
      })
      expect(after.runs).toHaveLength(0)
    })

    it('settles node children once and ignores later rewrites', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'settle-children',
        input: {},
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
          { childKey: 'item:0', kind: 'task', ordinal: 0, item: { id: 'a' } },
          { childKey: 'item:1', kind: 'task', ordinal: 1, item: { id: 'b' } },
        ],
      })

      const completed = await runtime.store.completeNodeChild({
        runId: run.id,
        nodeName: 'items',
        childKey: 'item:0',
        output: { id: 'one' },
      })
      const failedAfterComplete = await runtime.store.failNodeChild({
        runId: run.id,
        nodeName: 'items',
        childKey: 'item:0',
        error: new Error('too-late'),
      })
      const completedAgain = await runtime.store.completeNodeChild({
        runId: run.id,
        nodeName: 'items',
        childKey: 'item:0',
        output: { id: 'rewrite' },
      })
      const failed = await runtime.store.failNodeChild({
        runId: run.id,
        nodeName: 'items',
        childKey: 'item:1',
        error: new Error('boom'),
      })
      const completedAfterFail = await runtime.store.completeNodeChild({
        runId: run.id,
        nodeName: 'items',
        childKey: 'item:1',
        output: { id: 'late' },
      })
      const missing = await runtime.store.completeNodeChild({
        runId: run.id,
        nodeName: 'items',
        childKey: 'item:9',
        output: {},
      })

      expect(completed?.status).toBe('completed')
      expect(completed?.output).toStrictEqual({ id: 'one' })
      expect(failedAfterComplete?.status).toBe('completed')
      expect(failedAfterComplete?.output).toStrictEqual({ id: 'one' })
      expect(completedAgain?.status).toBe('completed')
      expect(completedAgain?.output).toStrictEqual({ id: 'one' })
      expect(failed?.status).toBe('failed')
      expect(failed?.error?.message).toBe('boom')
      expect(completedAfterFail?.status).toBe('failed')
      expect(completedAfterFail?.error?.message).toBe('boom')
      expect(missing).toBeUndefined()
    })

    it('numbers attempts per child and fences settlement by current attempt', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'parallel-attempts',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'members',
        kind: 'parallel',
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'members',
        children: [
          { childKey: 'member:a', kind: 'activity' },
          { childKey: 'member:b', kind: 'activity' },
        ],
      })

      const firstA = await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'members',
        childKey: 'member:a',
        input: { member: 'a' },
      })
      const replayA = await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'members',
        childKey: 'member:a',
        input: { member: 'a' },
      })
      const firstB = await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'members',
        childKey: 'member:b',
        input: { member: 'b' },
      })

      expect(firstA.created).toBe(true)
      expect(firstA.attempt).toMatchObject({
        childKey: 'member:a',
        attemptNumber: 1,
      })
      expect(replayA.created).toBe(false)
      expect(replayA.attempt.id).toBe(firstA.attempt.id)
      expect(firstB.created).toBe(true)
      // Attempt numbers are per child: a sibling member also starts at 1.
      expect(firstB.attempt).toMatchObject({
        childKey: 'member:b',
        attemptNumber: 1,
      })

      const failedA = await runtime.store.failCurrentAttempt({
        attemptId: firstA.attempt.id,
        leaseToken: firstA.attempt.leaseToken!,
        error: new Error('first try failed'),
      })
      expect(failedA?.status).toBe('failed')
      // Failing an attempt settles only the attempt; the child stays open for
      // the retry decision.
      const afterFail = await runtime.store.loadNodeChildren({
        runId: run.id,
        nodeName: 'members',
      })
      expect(afterFail.children).toMatchObject([
        { childKey: 'member:a', status: 'running', attemptCount: 1 },
        { childKey: 'member:b', status: 'running', attemptCount: 1 },
      ])

      const retryA = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'members',
        childKey: 'member:a',
        input: { member: 'a', retry: true },
      })
      const retryB = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'members',
        childKey: 'member:b',
        input: { member: 'b', retry: true },
      })
      expect(retryA).toMatchObject({ childKey: 'member:a', attemptNumber: 2 })
      expect(retryB).toMatchObject({ childKey: 'member:b', attemptNumber: 2 })

      // A superseded attempt holds a valid lease but is no longer the child's
      // current attempt, so it cannot complete the child.
      const superseded = await runtime.store.completeCurrentAttempt({
        attemptId: firstB.attempt.id,
        leaseToken: firstB.attempt.leaseToken!,
        output: { member: 'b', stale: true },
      })
      expect(superseded).toBeUndefined()

      const completedB = await runtime.store.completeCurrentAttempt({
        attemptId: retryB.id,
        leaseToken: retryB.leaseToken!,
        output: { member: 'b' },
      })
      expect(completedB?.status).toBe('completed')

      const settled = await runtime.store.loadNodeChildren({
        runId: run.id,
        nodeName: 'members',
      })
      expect(settled.children).toMatchObject([
        {
          childKey: 'member:a',
          status: 'running',
          attemptCount: 2,
          currentAttemptId: retryA.id,
        },
        {
          childKey: 'member:b',
          status: 'completed',
          attemptCount: 2,
          output: { member: 'b' },
        },
      ])
      expect(
        settled.attempts
          .map((attempt) => [attempt.childKey, attempt.attemptNumber])
          .sort(
            (left, right) =>
              String(left[0]).localeCompare(String(right[0])) ||
              Number(left[1]) - Number(right[1]),
          ),
      ).toEqual([
        ['member:a', 1],
        ['member:a', 2],
        ['member:b', 1],
        ['member:b', 2],
      ])
      await expect(
        runtime.store.createAttempt({
          runId: run.id,
          nodeName: 'members',
          childKey: 'member:c',
          input: {},
        }),
      ).rejects.toThrow('Missing node child')
    })

    it('orders node children by ordinal then child key', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'ordered-children',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'members',
        kind: 'parallel',
      })

      const ensured = await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'members',
        children: [
          { childKey: 'member:b', kind: 'activity', ordinal: 2 },
          { childKey: 'member:z', kind: 'activity', ordinal: 0 },
          { childKey: 'member:a', kind: 'activity', ordinal: 2 },
          { childKey: 'member:m', kind: 'activity', ordinal: 1 },
        ],
      })
      const loaded = await runtime.store.loadNodeChildren({
        runId: run.id,
        nodeName: 'members',
      })

      const expectedOrder = ['member:z', 'member:m', 'member:a', 'member:b']
      expect(ensured.children.map((child) => child.childKey)).toStrictEqual(
        expectedOrder,
      )
      expect(loaded.children.map((child) => child.childKey)).toStrictEqual(
        expectedOrder,
      )
    })

    it('moves runs between running and waiting through legal transitions only', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'run-status-workflow',
        input: {},
      })
      const missingUuid = '00000000-0000-4000-8000-000000000000'

      // Waiting is only reachable from running, so a queued run cannot park.
      const parkedFromQueued = await runtime.store.markRunWaiting({
        runId: run.id,
      })
      const running = await runtime.store.markRunRunning({ runId: run.id })
      const waiting = await runtime.store.markRunWaiting({ runId: run.id })
      const resumed = await runtime.store.markRunRunning({ runId: run.id })

      expect(parkedFromQueued?.status).toBe('queued')
      expect(running?.status).toBe('running')
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
      await expect(
        runtime.store.markRunRunning({ runId: missingUuid }),
      ).resolves.toBeUndefined()
      await expect(
        runtime.store.markRunWaiting({ runId: missingUuid }),
      ).resolves.toBeUndefined()
    })

    it('preserves stored error cause chains', async () => {
      const runtime = await createRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'adapter-error-cause-workflow',
        input: { scenario: 'alpha' },
      })
      const error = new Error('outer failure', {
        cause: new Error('inner cause'),
      })

      const failed = await runtime.store.failRun({
        runId: run.id,
        error,
      })

      expect(failed?.error).toMatchObject({
        name: 'Error',
        message: 'outer failure',
        cause: {
          name: 'Error',
          message: 'inner cause',
        },
      })
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
      await runtime.store.ensureNodeChildren({
        runId: first.id,
        nodeName: 'first-node',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      await runtime.store.ensureNodeChildren({
        runId: second.id,
        nodeName: 'second-node',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      await runtime.store.createAttempt({
        runId: first.id,
        nodeName: 'first-node',
        childKey: '$self',
        input: { run: 1 },
      })
      await runtime.store.createAttempt({
        runId: second.id,
        nodeName: 'second-node',
        childKey: '$self',
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
      await runtime.store.ensureNodeChildren({
        runId: first.id,
        nodeName: 'child',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      await runtime.store.ensureChildRun({
        runId: first.id,
        nodeName: 'child',
        childKey: '$self',
        childKind: 'workflow',
        childName: 'child',
        input: { run: 1 },
        rootRunId: first.rootRunId,
      })
      await runtime.store.ensureNodeChildren({
        runId: first.id,
        nodeName: 'items',
        children: [
          {
            childKey: 'item:0',
            kind: 'task',
            ordinal: 0,
            itemKey: 'one',
            item: { run: 1 },
          },
        ],
      })

      const firstSnapshot = await runtime.store.loadRunSnapshot(first.id)
      const secondSnapshot = await runtime.store.loadRunSnapshot(second.id)

      expect(firstSnapshot?.run.id).toBe(first.id)
      expect(firstSnapshot?.nodes.map((node) => node.name)).toEqual(
        expect.arrayContaining(['first-node', 'child', 'items']),
      )
      expect(
        firstSnapshot?.attempts.map((attempt) => attempt.runId),
      ).toStrictEqual([first.id])
      expect(
        firstSnapshot?.children
          .map((child) => `${child.nodeName}:${child.childKey}`)
          .sort(),
      ).toStrictEqual(['child:$self', 'first-node:$self', 'items:item:0'])
      expect(
        firstSnapshot?.children.every((child) => child.runId === first.id),
      ).toBe(true)
      expect(secondSnapshot?.run.id).toBe(second.id)
      expect(secondSnapshot?.nodes.map((node) => node.name)).toStrictEqual([
        'second-node',
      ])
      expect(
        secondSnapshot?.attempts.map((attempt) => attempt.runId),
      ).toStrictEqual([second.id])
      expect(
        secondSnapshot?.children.map((child) => [
          child.runId,
          child.nodeName,
          child.childKey,
        ]),
      ).toStrictEqual([[second.id, 'second-node', '$self']])
    })

    it('lists run summaries without payloads and matches listRuns pagination', async () => {
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const first = await runtime.store.createRun({
        workflowName: 'summary-root',
        input: { root: 1 },
      })
      await runtime.store.createNode({
        runId: first.id,
        name: 'done',
        kind: 'activity',
      })
      await runtime.store.createNode({
        runId: first.id,
        name: 'pending',
        kind: 'activity',
      })
      await runtime.store.completeNode({
        runId: first.id,
        nodeName: 'done',
        output: { ok: true },
      })
      const child = await runtime.store.createRun({
        workflowName: 'summary-child',
        input: { child: true },
        parentRunId: first.id,
        parentNodeName: 'done',
        rootRunId: first.rootRunId,
      })
      const second = await runtime.store.createRun({
        workflowName: 'summary-root',
        input: { root: 2 },
      })

      const roots = await runtime.store.listRunSummaries({
        name: 'summary-root',
        parentRunId: null,
      })
      const childSummaries = await runtime.store.listRunSummaries({
        parentRunId: first.id,
      })
      const runPage = await runtime.store.listRuns({
        name: 'summary-root',
        limit: 1,
      })
      const summaryPage = await client.listSummaries({
        name: 'summary-root',
        limit: 1,
      })
      const nextSummaryPage = await client.listSummaries({
        name: 'summary-root',
        cursor: summaryPage.nextCursor,
        limit: 1,
      })

      expect(roots.runs.map((run) => run.id)).toStrictEqual([
        second.id,
        first.id,
      ])
      expect(childSummaries.runs.map((run) => run.id)).toStrictEqual([child.id])
      expect(summaryPage.runs.map((run) => run.id)).toStrictEqual(
        runPage.runs.map((run) => run.id),
      )
      expect(summaryPage.nextCursor).toBe(runPage.nextCursor)
      expect(nextSummaryPage.runs.map((run) => run.id)).toStrictEqual([
        first.id,
      ])
      const firstSummary = roots.runs.find((run) => run.id === first.id)!
      expect(firstSummary.nodesTotal).toBe(2)
      expect(firstSummary.nodesCompleted).toBe(1)
      expect('input' in firstSummary).toBe(false)
      expect('output' in firstSummary).toBe(false)
    })

    it('loads run details and node snapshots with the requested payload shape', async () => {
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const run = await runtime.store.createRun({
        workflowName: 'detail-parent',
        input: { secret: 'run-input' },
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'fanout',
        kind: 'parallel',
      })
      await runtime.store.setNodeInput({
        runId: run.id,
        nodeName: 'fanout',
        input: { secret: 'node-input' },
      })
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'fanout',
        children: [
          { childKey: 'member:a', kind: 'activity' },
          { childKey: 'member:b', kind: 'workflow' },
        ],
      })
      const failed = await runtime.store.ensureChildAttempt({
        runId: run.id,
        nodeName: 'fanout',
        childKey: 'member:a',
        input: { secret: 'attempt-input-1' },
      })
      await runtime.store.failCurrentAttempt({
        attemptId: failed.attempt.id,
        leaseToken: failed.attempt.leaseToken!,
        error: new Error('first attempt failed'),
      })
      const retry = await runtime.store.createAttempt({
        runId: run.id,
        nodeName: 'fanout',
        childKey: 'member:a',
        input: { secret: 'attempt-input-2' },
      })
      await runtime.store.completeCurrentAttempt({
        attemptId: retry.id,
        leaseToken: retry.leaseToken!,
        output: { secret: 'attempt-output' },
      })
      const { childRun } = await runtime.store.ensureChildRun({
        runId: run.id,
        nodeName: 'fanout',
        childKey: 'member:b',
        childKind: 'workflow',
        childName: 'detail-child',
        input: { secret: 'child-input' },
        rootRunId: run.rootRunId,
      })
      await runtime.store.completeRun({
        runId: childRun.id,
        output: { secret: 'child-output' },
      })
      await runtime.store.completeNode({
        runId: run.id,
        nodeName: 'fanout',
        output: { secret: 'node-output' },
      })

      const detail = await client.getDetail(run.id)
      const nodeSnapshot = await client.getNode(run.id, 'fanout')

      expect(detail?.run).toMatchObject({
        id: run.id,
        nodesTotal: 1,
        nodesCompleted: 1,
      })
      expect('input' in detail!.run).toBe(false)
      expect('output' in detail!.run).toBe(false)
      expect(detail?.nodes).toHaveLength(1)
      expect('input' in detail!.nodes[0]!).toBe(false)
      expect('output' in detail!.nodes[0]!).toBe(false)
      expect(detail?.children.map((child) => child.childKey)).toStrictEqual([
        'member:a',
        'member:b',
      ])
      expect('input' in detail!.children[0]!).toBe(false)
      expect('output' in detail!.children[0]!).toBe(false)
      expect('item' in detail!.children[0]!).toBe(false)
      expect(detail?.attempts).toHaveLength(2)
      expect(detail?.attempts[0]?.error?.message).toBe('first attempt failed')
      expect('input' in detail!.attempts[0]!).toBe(false)
      expect('output' in detail!.attempts[1]!).toBe(false)
      expect(detail?.childRuns.map((summary) => summary.id)).toStrictEqual([
        childRun.id,
      ])
      expect(detail?.childRuns[0]).toMatchObject({
        status: 'completed',
        nodesTotal: 0,
        nodesCompleted: 0,
      })
      expect('input' in detail!.childRuns[0]!).toBe(false)
      expect('output' in detail!.childRuns[0]!).toBe(false)

      expect(nodeSnapshot?.node.input).toStrictEqual({ secret: 'node-input' })
      expect(nodeSnapshot?.node.output).toStrictEqual({
        secret: 'node-output',
      })
      expect(nodeSnapshot?.children[0]?.output).toStrictEqual({
        secret: 'attempt-output',
      })
      expect(nodeSnapshot?.attempts.map((attempt) => attempt.input)).toEqual([
        { secret: 'attempt-input-1' },
        { secret: 'attempt-input-2' },
      ])
      expect(nodeSnapshot?.attempts[1]?.output).toStrictEqual({
        secret: 'attempt-output',
      })
      await expect(
        client.getDetail('00000000-0000-4000-8000-000000000000'),
      ).resolves.toBeUndefined()
      await expect(
        client.getNode(run.id, 'missing-node'),
      ).resolves.toBeUndefined()
    })

    it('lists a run family from any member with child origins', async () => {
      const runtime = await createRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const root = await runtime.store.createRun({
        workflowName: 'family-root',
        input: { root: true },
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'members',
        kind: 'parallel',
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'members',
        children: [{ childKey: 'member:x', kind: 'workflow' }],
      })
      const { childRun: member } = await runtime.store.ensureChildRun({
        runId: root.id,
        nodeName: 'members',
        childKey: 'member:x',
        childKind: 'workflow',
        childName: 'family-member',
        input: { member: true },
        rootRunId: root.rootRunId,
      })
      await runtime.store.createNode({
        runId: root.id,
        name: 'items',
        kind: 'mapWorkflow',
      })
      await runtime.store.ensureNodeChildren({
        runId: root.id,
        nodeName: 'items',
        children: [
          {
            childKey: 'item:0',
            kind: 'workflow',
            ordinal: 0,
            item: { id: 0 },
          },
        ],
      })
      const { childRun: item } = await runtime.store.ensureChildRun({
        runId: root.id,
        nodeName: 'items',
        childKey: 'item:0',
        childKind: 'workflow',
        childName: 'family-item',
        input: { item: true },
        rootRunId: root.rootRunId,
      })
      await runtime.store.createNode({
        runId: member.id,
        name: 'nested',
        kind: 'workflow',
      })
      await runtime.store.ensureNodeChildren({
        runId: member.id,
        nodeName: 'nested',
        children: [{ childKey: '$self', kind: 'workflow' }],
      })
      const { childRun: grandchild } = await runtime.store.ensureChildRun({
        runId: member.id,
        nodeName: 'nested',
        childKey: '$self',
        childKind: 'workflow',
        childName: 'family-grandchild',
        input: { grandchild: true },
        rootRunId: root.rootRunId,
      })

      const family = await client.getFamily(member.id)

      expect(family.map((entry) => entry.run.id)).toStrictEqual([
        root.id,
        member.id,
        item.id,
        grandchild.id,
      ])
      expect(family[0]?.origin).toBeUndefined()
      expect(family[1]?.origin).toStrictEqual({
        nodeName: 'members',
        childKey: 'member:x',
      })
      expect(family[2]?.origin).toStrictEqual({
        nodeName: 'items',
        childKey: 'item:0',
      })
      expect(family[3]?.origin).toStrictEqual({
        nodeName: 'nested',
        childKey: '$self',
      })
      expect(family.every((entry) => !('input' in entry.run))).toBe(true)
      expect(
        await client.getFamily('00000000-0000-4000-8000-000000000000'),
      ).toStrictEqual([])
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
workflowRuntimeAdapterContract('postgres', async (options) => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  return createPostgresWorkflowRuntime({ connection, ...options })
})

describe('postgres workflow runtime adapter invariant recovery', () => {
  it('lists each run family member once when child origins duplicate', async () => {
    const connection = createPgliteConnection()
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    const root = await runtime.store.createRun({
      workflowName: 'family-duplicate-root',
      input: { root: true },
    })
    await runtime.store.createNode({
      runId: root.id,
      name: 'members',
      kind: 'parallel',
    })
    await runtime.store.ensureNodeChildren({
      runId: root.id,
      nodeName: 'members',
      children: [{ childKey: 'member:x', kind: 'workflow' }],
    })
    const { childRun: member } = await runtime.store.ensureChildRun({
      runId: root.id,
      nodeName: 'members',
      childKey: 'member:x',
      childKind: 'workflow',
      childName: 'family-duplicate-member',
      input: { member: true },
      rootRunId: root.rootRunId,
    })
    await runtime.store.createNode({
      runId: root.id,
      name: 'zzz-duplicate-origin',
      kind: 'workflow',
    })
    await connection.query(
      `
        INSERT INTO workflow_node_children (
          run_id, node_name, child_key, kind, status, ordinal,
          child_run_id, attempt_count, version, created_at, updated_at
        )
        VALUES (
          $1, 'zzz-duplicate-origin', 'member:z', 'workflow', 'pending', 0,
          $2, 0, 1, now(), now()
        )
      `,
      [root.id, member.id],
    )

    const family = await runtime.store.listRunFamily(member.id)

    expect(family.map((entry) => entry.run.id)).toStrictEqual([
      root.id,
      member.id,
    ])
    expect(family[1]?.origin).toStrictEqual({
      nodeName: 'members',
      childKey: 'member:x',
    })
  })
})
