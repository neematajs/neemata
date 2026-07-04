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
        maxIdleClaims: 3,
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
      const childRunId = waiting?.childLinks[0]?.childRunId
      expect(childRunId).toBeTypeOf('string')

      await client.cancel(run.id)
      await runWorkflowWorker({
        ...runtime,
        container: testContainer,
        workflows: [parentImplementation],
        workerId: 'parent-worker-2',
        maxIdleClaims: 3,
      })
      await runWorkflowWorker({
        ...runtime,
        container: testContainer,
        workflows: [childImplementation],
        workerId: 'child-worker-1',
        maxIdleClaims: 3,
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
        runtime.attemptExecutor.claimTask({
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
          status: 'waiting',
          input: { text: 'alpha' },
        },
      ])
      await expect(
        runtime.attemptExecutor.claimTask({
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
      const claimed = await runtime.attemptExecutor.claimTask({
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
        runtime.attemptExecutor.claimTask({
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
        attemptId: '00000000-0000-4000-8000-000000000212',
        leaseToken: 'attempt-lease',
        input: {},
      }
      await runtime.attemptExecutor.dispatchActivity(command)
      const claimed = await runtime.attemptExecutor.claimActivity({
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
      const requeued = await runtime.attemptExecutor.claimActivity({
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
      const { childRun } = await runtime.store.ensureChildWorkflowRun({
        identity: { runId: root.id, nodeName: 'child' },
        workflowName: 'pruned-child-workflow',
        input: {},
        parentRunId: root.id,
        parentNodeName: 'child',
        rootRunId: root.id,
      })
      await runtime.store.ensureMapItems({
        runId: root.id,
        nodeName: 'map',
        items: [{ id: 'a' }, { id: 'b' }],
      })
      const attempt = await runtime.store.createAttempt({
        runId: root.id,
        nodeName: 'content',
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
        runtime.attemptExecutor.claimActivity({
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
      const { childRun } = await runtime.store.ensureChildWorkflowRun({
        identity: { runId: liveParent.id, nodeName: 'child' },
        workflowName: 'terminal-child-prune-survivor',
        input: {},
        parentRunId: liveParent.id,
        parentNodeName: 'child',
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
          maxIdleClaims: 1,
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

      const activityBeforeBackoff = await runtime.attemptExecutor.claimActivity(
        {
          workerId: 'activity-worker-2',
          workflowNames: ['attempt-workflow'],
          activityNames: ['content'],
          leaseMs: 30_000,
        },
      )
      expect(activityBeforeBackoff).toBeNull()

      await waitForReleaseBackoff()

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
      await expect(
        runtime.attemptExecutor.heartbeat(task!),
      ).resolves.toStrictEqual({ runStatus: 'queued' })

      await runtime.attemptExecutor.release(task!)

      const taskBeforeBackoff = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-2',
        taskNames: ['embedding'],
        leaseMs: 30_000,
      })
      expect(taskBeforeBackoff).toBeNull()

      await waitForReleaseBackoff()

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
          input: { text: 'too-late' },
        }),
      ).rejects.toThrow(/terminal/i)
      await expect(
        runtime.store.ensureNodeAttempt({
          identity: { runId: run.id, nodeName: 'content', caseKey: 'late' },
          kind: 'activity',
          input: { text: 'too-late' },
        }),
      ).rejects.toThrow(/terminal/i)

      expect(stale).toBeUndefined()
      expect(wrongToken).toBeUndefined()
      expect(completed?.output).toStrictEqual({ text: 'fresh' })
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
      const claimed = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-1',
        workflowNames: ['delete-unclaimed-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })

      const deleted = await runtime.attemptExecutor.deleteUnclaimed({
        runId: run.id,
      })
      const remainingClaim = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-2',
        workflowNames: ['delete-unclaimed-workflow'],
        activityNames: ['content'],
        leaseMs: 30_000,
      })
      await runtime.attemptExecutor.ack(claimed!)
      await runtime.attemptExecutor.ack(remainingClaim!)
      const emptyClaim = await runtime.attemptExecutor.claimActivity({
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
      await runtime.store.createNode({
        runId: parent.id,
        name: 'keyless-items',
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
      const firstKeylessItems = await runtime.store.ensureMapItems({
        runId: parent.id,
        nodeName: 'keyless-items',
        items: [{ currency: 'USD', amount: 5 }],
        keys: [undefined],
      })
      const sameKeylessItems = await runtime.store.ensureMapItems({
        runId: parent.id,
        nodeName: 'keyless-items',
        items: [{ currency: 'USD', amount: 5 }],
        keys: [undefined],
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
      expect(firstKeylessItems.created).toBe(true)
      expect(sameKeylessItems.created).toBe(false)
      expect(sameKeylessItems.items).toStrictEqual(firstKeylessItems.items)
      const completedItem = await runtime.store.completeMapItem({
        runId: parent.id,
        nodeName: 'items',
        itemIndex: 0,
        itemKey: 'one',
        output: { id: 'one' },
      })
      const failedAfterComplete = await runtime.store.failMapItem({
        runId: parent.id,
        nodeName: 'items',
        itemIndex: 0,
        itemKey: 'one',
        error: new Error('too-late'),
      })
      expect(completedItem?.status).toBe('completed')
      expect(failedAfterComplete?.status).toBe('completed')
      expect(failedAfterComplete?.output).toStrictEqual({ id: 'one' })
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
      expect(
        firstSnapshot?.attempts.map((attempt) => attempt.runId),
      ).toStrictEqual([first.id])
      expect(firstSnapshot?.childLinks).toHaveLength(1)
      expect(firstSnapshot?.mapItems).toHaveLength(1)
      expect(secondSnapshot?.run.id).toBe(second.id)
      expect(secondSnapshot?.nodes.map((node) => node.name)).toStrictEqual([
        'second-node',
      ])
      expect(
        secondSnapshot?.attempts.map((attempt) => attempt.runId),
      ).toStrictEqual([second.id])
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
workflowRuntimeAdapterContract('postgres', async (options) => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  return createPostgresWorkflowRuntime({ connection, ...options })
})
