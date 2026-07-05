import { Container, createLogger, createValueInjectable } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import { createRunLeaseFencedStore } from '../src/runtime/coordinator.ts'
import {
  continueWorkflowRun,
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runActivityAttempt,
  runTaskAttempt,
  runWorkflowWorker,
  startTaskRun,
  startWorkflowRun,
  type WorkflowStore,
} from '../src/runtime/index.ts'

describe('workflow runtime coordinator', () => {
  const createTestContainer = () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    return new Container({ logger })
  }

  it('starts a workflow run and enqueues continuation', async () => {
    const workflow = defineWorkflow({
      name: 'started-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow,
      input: { scenario: 'alpha' },
      tags: { curriculumId: 'curriculum-1' },
      idempotencyKey: ['started-workflow', 'alpha'],
    })

    expect(run).toMatchObject({
      kind: 'workflow',
      name: workflow.name,
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
      tags: { curriculumId: 'curriculum-1' },
      idempotencyKey: ['started-workflow', 'alpha'],
    })
    expect(runtime.inspect().continueRunCommands).toMatchObject([
      {
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      },
    ])
  })

  it('computes workflow start tags and idempotency from its definition', async () => {
    const workflow = defineWorkflow({
      name: 'implemented-start-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
      tags: (input) => ({
        prefix: 'wf',
        scenario: input.scenario,
      }),
      idempotency: (input) => ['wf', 'workflow', input.scenario],
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      workflow,
      implementation,
      input: { scenario: 'alpha' },
    })

    expect(run.tags).toStrictEqual({ prefix: 'wf', scenario: 'alpha' })
    expect(run.idempotencyKey).toStrictEqual(['wf', 'workflow', 'alpha'])
  })

  it('computes task start idempotency from its definition', async () => {
    const task = defineTask({
      name: 'implemented-start-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      idempotency: (input) => ['task', input.text],
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      implementation,
      input: { text: 'alpha' },
    })

    expect(run.idempotencyKey).toStrictEqual(['task', 'alpha'])
    expect(
      runtime.inspect().taskCommands[0]?.payload.idempotencyKey,
    ).toStrictEqual(['task', 'alpha'])
  })

  it('renews the run lease while a workflow continuation is running', async () => {
    vi.useFakeTimers()
    const workflow = defineWorkflow({
      name: 'lease-renewal-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    let enteredFinish!: () => void
    const finishStarted = new Promise<void>((resolve) => {
      enteredFinish = resolve
    })
    const implementation = implementWorkflow(workflow).finish(
      async (_ctx, _outputs, input) => {
        enteredFinish()
        await new Promise((resolve) => setTimeout(resolve, 120))
        return { text: input.text }
      },
    )
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    let observedRenewal!: () => void
    const renewed = new Promise<void>((resolve) => {
      observedRenewal = resolve
    })
    const store = {
      ...runtime.store,
      renewRunLease: async (
        ...args: Parameters<typeof runtime.store.renewRunLease>
      ) => {
        const result = await runtime.store.renewRunLease(...args)
        if (result) observedRenewal()
        return result
      },
    }
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    try {
      const continuation = continueWorkflowRun({
        store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command,
        leaseMs: 50,
      })
      await finishStarted
      await vi.advanceTimersByTimeAsync(20)
      await renewed

      const stolen = await runtime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 100,
      })

      expect(stolen).toBeUndefined()
      await vi.advanceTimersByTimeAsync(120)
      await expect(continuation).resolves.toStrictEqual({ status: 'processed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not complete a run after losing the run lease', async () => {
    const workflow = defineWorkflow({
      name: 'stale-lease-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    let finishEntered = false
    const implementation = implementWorkflow(workflow).finish(
      async (_ctx, _outputs, input) => {
        finishEntered = true
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { text: input.text }
      },
    )
    const runtime = createInMemoryWorkflowRuntime()
    const store = {
      ...runtime.store,
      renewRunLease: async (
        ...args: Parameters<typeof runtime.store.renewRunLease>
      ) => {
        if (finishEntered) return undefined
        return runtime.store.renewRunLease(...args)
      },
    }
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
        leaseMs: 30,
      }),
    ).resolves.toStrictEqual({ status: 'busy' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.run.output).toBeUndefined()
  })

  it('renews the run lease before every fenced store mutation', async () => {
    const lease = { runId: 'run-1', leaseToken: 'lease-token', version: 1 }
    const mutatingStoreCalls = [
      ['createRun', { workflowName: 'workflow', input: {} }],
      ['createNode', { runId: 'run-1', name: 'node', kind: 'activity' }],
      ['setNodeInput', { runId: 'run-1', nodeName: 'node', input: {} }],
      ['createAttempt', { runId: 'run-1', nodeName: 'node', input: {} }],
      [
        'completeCurrentAttempt',
        { attemptId: 'attempt-1', leaseToken: 'attempt-lease', output: {} },
      ],
      [
        'failCurrentAttempt',
        { attemptId: 'attempt-1', leaseToken: 'attempt-lease', error: {} },
      ],
      ['completeNode', { runId: 'run-1', nodeName: 'node', output: {} }],
      ['failNode', { runId: 'run-1', nodeName: 'node', error: {} }],
      ['completeRun', { runId: 'run-1', output: {} }],
      ['failRun', { runId: 'run-1', error: {} }],
      ['requestRunCancellation', { runId: 'run-1' }],
      ['cancelRun', { runId: 'run-1' }],
      ['cancelNode', { runId: 'run-1', nodeName: 'node' }],
      ['cancelNonTerminalRunNodes', { runId: 'run-1' }],
      [
        'ensureNodeAttempt',
        {
          identity: { runId: 'run-1', nodeName: 'node' },
          kind: 'activity',
          input: {},
        },
      ],
      [
        'ensureChildWorkflowRun',
        {
          identity: { runId: 'run-1', nodeName: 'node' },
          workflowName: 'child',
          input: {},
          parentRunId: 'run-1',
          parentNodeName: 'node',
          rootRunId: 'run-1',
        },
      ],
      [
        'ensureChildRun',
        {
          identity: { runId: 'run-1', nodeName: 'node' },
          childKind: 'task',
          childName: 'child',
          input: {},
          parentRunId: 'run-1',
          parentNodeName: 'node',
          rootRunId: 'run-1',
        },
      ],
      ['selectNodeCase', { runId: 'run-1', nodeName: 'node', caseKey: 'a' }],
      ['ensureMapItems', { runId: 'run-1', nodeName: 'node', items: [] }],
      [
        'completeMapItem',
        { runId: 'run-1', nodeName: 'node', itemIndex: 0, output: {} },
      ],
      [
        'failMapItem',
        { runId: 'run-1', nodeName: 'node', itemIndex: 0, error: {} },
      ],
      ['waitNode', { runId: 'run-1', nodeName: 'node' }],
    ] as const

    for (const [method, params] of mutatingStoreCalls) {
      const log: string[] = []
      const store = {
        ...createInMemoryWorkflowRuntime().store,
        renewRunLease: async (observedLease: typeof lease, leaseMs: number) => {
          expect(observedLease).toBe(lease)
          expect(leaseMs).toBe(123)
          log.push('renewRunLease')
          return lease
        },
        [method]: async () => {
          log.push(method)
          return undefined
        },
      } as unknown as WorkflowStore
      const fenced = createRunLeaseFencedStore(store, lease, 123)

      await (
        fenced[method as keyof WorkflowStore] as (
          params: unknown,
        ) => Promise<unknown>
      )(params)

      expect(log).toStrictEqual(['renewRunLease', method])
    }
  })

  it('cancels the run when a node is cancelled', async () => {
    const workflow = defineWorkflow({
      name: 'cancelled-node-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => input)
      .finish((_ctx, { content }) => content)
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const node = await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    const store = {
      ...runtime.store,
      loadRunSnapshot: async (
        ...args: Parameters<typeof runtime.store.loadRunSnapshot>
      ) => {
        const snapshot = await runtime.store.loadRunSnapshot(...args)
        if (!snapshot || snapshot.run.id !== run.id) return snapshot
        return {
          ...snapshot,
          nodes: [{ ...node, status: 'cancelled' as const }],
        }
      },
    }

    await expect(
      continueWorkflowRun({
        store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('cancelled')
  })

  it('cancels before failed-node handling when a cancelling run has a failed node', async () => {
    const workflow = defineWorkflow({
      name: 'guard-cancelling-before-failed',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => input)
      .finish((_ctx, { content }) => content)
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    await runtime.store.failNode({
      runId: run.id,
      nodeName: 'content',
      error: new Error('node failed'),
    })
    await runtime.store.requestRunCancellation({ runId: run.id })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('cancelled')
    expect(snapshot?.run.error).toBeUndefined()
  })

  it('fails before cancelled-node handling when a run has failed and cancelled nodes', async () => {
    const workflow = defineWorkflow({
      name: 'guard-failed-before-cancelled-node',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('failedContent', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .activity('cancelledContent', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .failedContent(async (_ctx, input) => input)
      .cancelledContent(async (_ctx, input) => input)
      .finish((_ctx, outputs) => outputs.failedContent)
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'failedContent',
      kind: 'activity',
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'cancelledContent',
      kind: 'activity',
    })
    await runtime.store.failNode({
      runId: run.id,
      nodeName: 'failedContent',
      error: new Error('node failed'),
    })
    await runtime.store.cancelNode({
      runId: run.id,
      nodeName: 'cancelledContent',
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('failed')
    expect(snapshot?.run.error?.message).toBe('node failed')
  })

  it('cancels child task runs and deletes unclaimed child commands', async () => {
    const task = defineTask({
      name: 'cancel-child-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'cancel-child-task-parent',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', task)
      .build()
    const implementation = implementWorkflow(workflow)
      .embedding(task, {
        input: (_ctx, _outputs, input) => ({ text: input.text }),
      })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { text: 'alpha' })

    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })
    const waiting = await client.get(run.id)
    const childRunId = waiting?.childLinks[0]?.childRunId
    expect(childRunId).toBeTypeOf('string')
    expect(runtime.inspect().taskCommands).toHaveLength(1)

    await client.cancel(run.id)
    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-2',
      maxIdleClaims: 3,
    })

    const parent = await client.get(run.id)
    const child = await client.get(childRunId!)
    expect(parent?.run.status).toBe('cancelled')
    expect(parent?.nodes[0]?.status).toBe('cancelled')
    expect(child?.run.status).toBe('cancelled')
    expect(child?.nodes[0]?.status).toBe('cancelled')
    expect(runtime.inspect().taskCommands).toStrictEqual([])
  })

  it('drops a claimed child task attempt after parent cancellation', async () => {
    const task = defineTask({
      name: 'cancel-claimed-child-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'cancel-claimed-child-parent',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', task)
      .build()
    const workflowImplementation = implementWorkflow(workflow)
      .embedding(task, {
        input: (_ctx, _outputs, input) => ({ text: input.text }),
      })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))
    let taskCalls = 0
    const taskImplementation = implementTask(task, {
      handler: async (_ctx, input) => {
        taskCalls += 1
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { text: 'alpha' })

    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [workflowImplementation],
      workerId: 'workflow-worker-1',
    })
    const childRunId = (await client.get(run.id))?.childLinks[0]?.childRunId
    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [task.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await client.cancel(run.id)
    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [workflowImplementation],
      workerId: 'workflow-worker-2',
      maxIdleClaims: 3,
    })
    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })

    const parent = await client.get(run.id)
    const child = await client.get(childRunId!)
    expect(taskCalls).toBe(0)
    expect(parent?.run.status).toBe('cancelled')
    expect(child?.run.status).toBe('cancelled')
    expect(child?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().taskCommands).toStrictEqual([])
  })

  it('propagates child workflow cancellation up to the parent run', async () => {
    const childWorkflow = defineWorkflow({
      name: 'cancel-up-child',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'cancel-up-parent',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()
    const childImplementation = implementWorkflow(childWorkflow).finish(
      (_ctx, _outputs, input) => ({ id: input.text }),
    )
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow)
      .finish((_ctx, { child }) => ({ id: child.id }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(parentWorkflow, { text: 'alpha' })

    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-worker-1',
    })
    const childRunId = (await client.get(run.id))?.childLinks[0]?.childRunId
    expect(childRunId).toBeTypeOf('string')

    await client.cancel(childRunId!)
    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [childImplementation],
      workerId: 'child-worker-1',
      maxIdleClaims: 3,
    })
    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-worker-2',
      maxIdleClaims: 3,
    })

    const parent = await client.get(run.id)
    const child = await client.get(childRunId!)
    expect(child?.run.status).toBe('cancelled')
    expect(parent?.nodes[0]?.status).toBe('cancelled')
    expect(parent?.run.status).toBe('cancelled')
  })

  it('fails the workflow run when start enqueue fails', async () => {
    const workflow = defineWorkflow({
      name: 'enqueue-failing-started-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const store = runtime.store

    await expect(
      startWorkflowRun({
        store,
        runCoordinationExecutor: {
          ...runtime.runCoordinationExecutor,
          enqueue: async () => {
            throw new Error('enqueue failed')
          },
        },
        workflow,
        input: { scenario: 'alpha' },
      }),
    ).rejects.toThrow('enqueue failed')

    const runs = runtime.inspect().runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kind: 'workflow',
      name: workflow.name,
      workflowName: workflow.name,
      status: 'failed',
      input: { scenario: 'alpha' },
      error: { message: 'enqueue failed' },
    })
  })

  it('fails the task run when initial attempt dispatch fails', async () => {
    const task = defineTask({
      name: 'dispatch-failing-started-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const runtime = createInMemoryWorkflowRuntime()

    await expect(
      startTaskRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchTask: async () => {
            throw new Error('dispatch failed')
          },
        },
        task,
        input: { text: 'alpha' },
      }),
    ).rejects.toThrow('dispatch failed')

    const runs = runtime.inspect().runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      kind: 'task',
      name: task.name,
      workflowName: task.name,
      taskName: task.name,
      status: 'failed',
      input: { text: 'alpha' },
      error: { message: 'dispatch failed' },
    })
  })

  it('dispatches an activity attempt, stores node input, and completes run after continuation', async () => {
    const workflow = defineWorkflow({
      name: 'case-generation',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
      })
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const afterDispatch = runtime.inspect()
    expect(afterDispatch.activityCommands).toHaveLength(1)
    expect(afterDispatch.nodes[0]?.input).toStrictEqual({ scenario: 'alpha' })

    const attempt = afterDispatch.attempts[0]!
    await runtime.store.completeCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      output: { text: 'alpha' },
    })
    await runtime.store.completeNode({
      runId: run.id,
      nodeName: 'content',
      output: { text: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('completed')
    expect(snapshot?.run.output).toStrictEqual({ caseId: 'alpha' })
  })

  it('does not dispatch an activity when createNode observes terminal state', async () => {
    const workflow = defineWorkflow({
      name: 'terminal-node-race-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    await runtime.store.completeNode({
      runId: run.id,
      nodeName: 'content',
      output: { text: 'alpha' },
    })
    const staleStore = {
      ...runtime.store,
      loadRunSnapshot: async (runId: string) => {
        const snapshot = await runtime.store.loadRunSnapshot(runId)
        return snapshot
          ? {
              ...snapshot,
              nodes: [],
              attempts: [],
              childLinks: [],
              mapItems: [],
            }
          : undefined
      },
    }

    await expect(
      continueWorkflowRun({
        store: staleStore,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchActivity: async () => {
            throw new Error('activity queue down')
          },
        },
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    expect(runtime.inspect().activityCommands).toStrictEqual([])
    expect(runtime.inspect().attempts).toStrictEqual([])
    expect(
      (await runtime.store.loadRunSnapshot(run.id))?.nodes[0]?.status,
    ).toBe('completed')
  })

  it('propagates store errors inside dispatchers without failing the run as a user error', async () => {
    const workflow = defineWorkflow({
      name: 'dispatcher-store-error-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const store = {
      ...runtime.store,
      createAttempt: async () => {
        throw new Error('store createAttempt failed')
      },
    } satisfies WorkflowStore

    await expect(
      continueWorkflowRun({
        store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).rejects.toThrow('store createAttempt failed')

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.run.error).toBeUndefined()
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.nodes[0]?.error).toBeUndefined()
  })

  it('recovers an activity attempt after node input was stored without an attempt', async () => {
    const workflow = defineWorkflow({
      name: 'activity-attempt-recovery',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
      })
      .finish((_ctx, { content }) => ({ caseId: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    let failed = false
    const failingStore = {
      ...runtime.store,
      createAttempt: async (
        ...args: Parameters<typeof runtime.store.createAttempt>
      ) => {
        if (!failed) {
          failed = true
          throw new Error('attempt insert failed')
        }
        return runtime.store.createAttempt(...args)
      },
    }
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await expect(
      continueWorkflowRun({
        store: failingStore,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command,
      }),
    ).rejects.toThrow('attempt insert failed')

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.nodes[0]?.input).toStrictEqual({ scenario: 'alpha' })
    expect(snapshot?.attempts).toHaveLength(1)
    expect(runtime.inspect().activityCommands).toHaveLength(1)
  })

  it('stores activity attempt idempotency from implementation mapper', async () => {
    const workflow = defineWorkflow({
      name: 'activity-idempotency-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        idempotency: (_ctx, _outputs, input) => ['content', input.scenario],
      })
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.attempts[0]?.idempotencyKey).toStrictEqual([
      'content',
      'alpha',
    ])
    expect(
      runtime.inspect().activityCommands[0]?.payload.idempotencyKey,
    ).toStrictEqual(['content', 'alpha'])
  })

  it('passes the workflow run input to an activity input mapper', async () => {
    const workflow = defineWorkflow({
      name: 'activity-input-receives-run-input-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    let observedInput: unknown
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => {
          observedInput = input
          return { scenario: input.scenario }
        },
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    expect(observedInput).toStrictEqual({ scenario: 'alpha' })
    expect(
      (await runtime.store.loadRunSnapshot(run.id))?.nodes[0]?.input,
    ).toStrictEqual({ scenario: 'alpha' })
  })

  it('skips activity idempotency resolution when an attempt already exists', async () => {
    const workflow = defineWorkflow({
      name: 'activity-idempotency-replay-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    let idempotencyCalls = 0
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        idempotency: (_ctx, _outputs, input) => {
          idempotencyCalls += 1
          if (idempotencyCalls > 1) {
            throw new Error('activity idempotency mapper replayed')
          }
          return ['content', input.scenario]
        },
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    expect(idempotencyCalls).toBe(1)
    expect(runtime.inspect().activityCommands).toHaveLength(1)
  })

  it('stores child task run idempotency from implementation mapper', async () => {
    const task = defineTask({
      name: 'child-idempotency-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'child-task-idempotency-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', task)
      .build()

    const implementation = implementWorkflow(workflow)
      .embedding(task, {
        input: (_ctx, _outputs, input) => ({ text: input.scenario }),
        idempotency: (_ctx, _outputs, input) => ['embedding', input.scenario],
      })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = snapshot?.childLinks[0]?.childRunId
    expect(childRunId).toBeTypeOf('string')

    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId!)
    expect(childSnapshot?.run.idempotencyKey).toStrictEqual([
      'embedding',
      'alpha',
    ])
    expect(
      runtime.inspect().taskCommands[0]?.payload.idempotencyKey,
    ).toStrictEqual(['embedding', 'alpha'])
  })

  it('skips child task idempotency resolution when a child link already exists', async () => {
    const task = defineTask({
      name: 'child-idempotency-replay-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'child-task-idempotency-replay-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', task)
      .build()
    let idempotencyCalls = 0
    const implementation = implementWorkflow(workflow)
      .embedding(task, {
        input: (_ctx, _outputs, input) => ({ text: input.scenario }),
        idempotency: (_ctx, _outputs, input) => {
          idempotencyCalls += 1
          if (idempotencyCalls > 1) {
            throw new Error('idempotency mapper replayed')
          }
          return ['embedding', input.scenario]
        },
      })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(idempotencyCalls).toBe(1)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(runtime.inspect().taskCommands).toHaveLength(1)
  })

  it('skips child workflow idempotency resolution when a child link already exists', async () => {
    const childWorkflow = defineWorkflow({
      name: 'child-idempotency-replay-child-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ id: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'child-workflow-idempotency-replay-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()

    let idempotencyCalls = 0
    const implementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow, {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        idempotency: (_ctx, _outputs, input) => {
          idempotencyCalls += 1
          if (idempotencyCalls > 1) {
            throw new Error('workflow idempotency mapper replayed')
          }
          return ['child', input.scenario]
        },
      })
      .finish((_ctx, { child }) => ({ id: child.id }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = snapshot?.childLinks[0]?.childRunId
    expect(idempotencyCalls).toBe(1)
    expect(childRunId).toBeTypeOf('string')
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: childRunId,
          workflowName: childWorkflow.name,
        },
      },
    ])
  })

  it('re-enqueues an existing started child task attempt without duplicating commands', async () => {
    const task = defineTask({
      name: 'orphaned-child-attempt-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'orphaned-child-attempt-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('embedding', task)
      .build()
    const implementation = implementWorkflow(workflow)
      .embedding(task, {
        input: (_ctx, _outputs, input) => ({ text: input.scenario }),
      })
      .finish((_ctx, { embedding }) => ({ id: embedding.id }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'embedding',
      kind: 'task',
    })
    await runtime.store.setNodeInput({
      runId: run.id,
      nodeName: 'embedding',
      input: { text: 'alpha' },
    })
    const child = await runtime.store.ensureChildRun({
      identity: { runId: run.id, nodeName: 'embedding' },
      childKind: 'task',
      childName: task.name,
      input: { text: 'alpha' },
      parentRunId: run.id,
      parentNodeName: 'embedding',
      rootRunId: run.rootRunId,
    })
    await runtime.store.createNode({
      runId: child.childRun.id,
      name: '$task',
      kind: 'task',
    })
    await runtime.store.setNodeInput({
      runId: child.childRun.id,
      nodeName: '$task',
      input: { text: 'alpha' },
    })
    await runtime.store.ensureNodeAttempt({
      identity: { runId: child.childRun.id, nodeName: '$task' },
      kind: 'task',
      input: { text: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    expect(runtime.inspect().taskCommands).toHaveLength(0)
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    expect(runtime.inspect().taskCommands).toHaveLength(1)
    expect(runtime.inspect().taskCommands[0]?.payload.attemptId).toBe(
      runtime.inspect().attempts[0]?.id,
    )
  })

  it('ignores a continuation command whose workflow name does not match the stored run', async () => {
    const workflowA = defineWorkflow({
      name: 'stored-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const workflowB = defineWorkflow({
      name: 'command-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementationB = implementWorkflow(workflowB)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflowA.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementationB],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflowB.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes).toStrictEqual([])
    expect(runtime.inspect().activityCommands).toStrictEqual([])
  })

  it('runs a claimed activity attempt and enqueues continuation', async () => {
    const prefix = createValueInjectable('handled')
    const workflow = defineWorkflow({
      name: 'activity-worker',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(
        {
          dependencies: { prefix },
          handler: async (ctx, input) => ({
            text: `${String(ctx.prefix)}:${input.scenario}`,
          }),
        },
        {
          input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        },
      )
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('completed')
    expect(snapshot?.nodes[0]?.output).toStrictEqual({ text: 'handled:alpha' })
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      },
    ])
  })

  it('runs a branch activity case and completes from selected output', async () => {
    const workflow = defineWorkflow({
      name: 'branch-activity-workflow',
      input: t.object({
        kind: t.union(t.literal('normal'), t.literal('fallback')),
        scenario: t.string(),
      }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          normal: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
          fallback: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
        }),
      })
      .build()

    let selectCalls = 0
    const implementation = implementWorkflow(workflow)
      .content({
        select: (_ctx, _outputs, input) => {
          selectCalls += 1
          return input.kind
        },
        cases: (helpers) => ({
          normal: helpers.activity(
            async (_ctx, input) => ({ text: `normal:${input.scenario}` }),
            {
              input: (_ctx, _outputs, input) => ({
                scenario: input.scenario,
              }),
            },
          ),
          fallback: helpers.activity(
            async (_ctx, input) => ({ text: `fallback:${input.scenario}` }),
            {
              input: (_ctx, _outputs, input) => ({
                scenario: input.scenario,
              }),
            },
          ),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { kind: 'normal', scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const afterDispatch = await runtime.store.loadRunSnapshot(run.id)
    const activityCommands = runtime.inspect().activityCommands
    expect(afterDispatch?.nodes[0]?.selectedCase).toBe('normal')
    expect(afterDispatch?.nodes[0]?.status).toBe('waiting')
    expect(afterDispatch?.attempts).toHaveLength(1)
    expect(afterDispatch?.attempts[0]?.identity).toStrictEqual({
      runId: run.id,
      nodeName: 'content',
      caseKey: 'normal',
    })
    expect(activityCommands).toHaveLength(1)
    expect(activityCommands[0]?.payload).toMatchObject({
      kind: 'activityAttempt',
      workflowName: workflow.name,
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'alpha' },
    })
    expect(activityCommands[0]?.payload.activityName).not.toContain('fallback')

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    expect(selectCalls).toBe(1)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.selectedCase).toBe('normal')
    expect(final?.nodes[0]?.output).toStrictEqual({ text: 'normal:alpha' })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({ text: 'normal:alpha' })
  })

  it('does not reselect or duplicate branch activity attempts on repeated continuation', async () => {
    const workflow = defineWorkflow({
      name: 'branch-activity-dedupe',
      input: t.object({
        kind: t.literal('normal'),
        scenario: t.string(),
      }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          normal: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
          fallback: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
        }),
      })
      .build()

    let selectCalls = 0
    const implementation = implementWorkflow(workflow)
      .content({
        select: () => {
          selectCalls += 1
          return 'normal'
        },
        cases: (helpers) => ({
          normal: helpers.activity(
            async (_ctx, input) => ({ text: input.scenario }),
            {
              input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
            },
          ),
          fallback: helpers.activity(
            async (_ctx, input) => ({ text: input.scenario }),
            {
              input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
            },
          ),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { kind: 'normal', scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    const activityCommands = runtime.inspect().activityCommands
    const attemptId = activityCommands[0]?.payload.attemptId
    expect(selectCalls).toBe(1)
    expect(snapshot?.nodes[0]?.selectedCase).toBe('normal')
    expect(snapshot?.attempts).toHaveLength(1)
    expect(snapshot?.attempts[0]?.identity).toStrictEqual({
      runId: run.id,
      nodeName: 'content',
      caseKey: 'normal',
    })
    expect(activityCommands).toHaveLength(1)
    expect(activityCommands.map((item) => item.payload.attemptId)).toEqual([
      attemptId,
    ])
  })

  it('preserves a started branch activity attempt without duplicating its command', async () => {
    const workflow = defineWorkflow({
      name: 'branch-activity-redispatch-failure',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          normal: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
        }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content({
        select: () => 'normal',
        cases: (helpers) => ({
          normal: helpers.activity(async (_ctx, input) => ({
            text: input.scenario,
          })),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    expect(runtime.inspect().activityCommands).toHaveLength(1)

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [implementation],
        workerId: 'coordinator-1',
        command,
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(snapshot?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().activityCommands).toHaveLength(1)
  })

  it('preserves a completed branch activity attempt without redispatching it', async () => {
    const workflow = defineWorkflow({
      name: 'branch-activity-completed-redispatch-failure',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          normal: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
        }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content({
        select: () => 'normal',
        cases: (helpers) => ({
          normal: helpers.activity(async (_ctx, input) => ({
            text: input.scenario,
          })),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const attempt = runtime.inspect().attempts[0]!
    await runtime.store.completeCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      output: { text: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchActivity: async () => {
            throw new Error('activity queue down')
          },
        },
        container,
        workflows: [implementation],
        workerId: 'coordinator-1',
        command,
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(snapshot?.attempts[0]?.status).toBe('completed')
  })

  it('reuses original branch activity attempt input on repeated continuation', async () => {
    const workflow = defineWorkflow({
      name: 'branch-activity-input-reuse',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          normal: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
        }),
      })
      .build()

    let mapCalls = 0
    const implementation = implementWorkflow(workflow)
      .content({
        select: () => 'normal',
        cases: (helpers) => ({
          normal: helpers.activity(
            async (_ctx, input) => ({ text: input.scenario }),
            {
              input: (_ctx, _outputs, input) => {
                mapCalls += 1
                if (mapCalls > 1) throw new Error('mapper called twice')
                return { scenario: `${input.scenario}-${mapCalls}` }
              },
            },
          ),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(mapCalls).toBe(1)
    expect(snapshot?.nodes[0]?.input).toStrictEqual({ scenario: 'alpha-1' })
    expect(snapshot?.attempts[0]?.input).toStrictEqual({ scenario: 'alpha-1' })
    expect(
      runtime.inspect().activityCommands.map((item) => item.payload.input),
    ).toStrictEqual([{ scenario: 'alpha-1' }])
  })

  it('runs a branch activity case with an empty string key', async () => {
    const workflow = defineWorkflow({
      name: 'branch-empty-case',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          '': helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
        }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content({
        select: () => '',
        cases: (helpers) => ({
          '': helpers.activity(async (_ctx, input) => ({
            text: `empty:${input.scenario}`,
          })),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.selectedCase).toBe('')
    expect(snapshot?.nodes[0]?.status).toBe('completed')
    expect(snapshot?.nodes[0]?.output).toStrictEqual({ text: 'empty:alpha' })
  })

  it('runs a branch task case and completes from selected output', async () => {
    const task = defineTask({
      name: 'branch.generate-summary',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'branch-task-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          summary: helpers.task(task),
        }),
      })
      .build()

    const taskImplementation = implementTask(task, {
      handler: async (_ctx, input) => ({ text: `task:${input.scenario}` }),
    })
    const workflowImplementation = implementWorkflow(workflow)
      .content({
        select: () => 'summary',
        cases: (helpers) => ({
          summary: helpers.task(task, {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          }),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [workflowImplementation],
      workerId: 'coordinator-1',
      command,
    })

    const afterDispatch = await runtime.store.loadRunSnapshot(run.id)
    const taskCommands = runtime.inspect().taskCommands
    expect(afterDispatch?.nodes[0]?.selectedCase).toBe('summary')
    expect(afterDispatch?.nodes[0]?.status).toBe('waiting')
    expect(afterDispatch?.attempts).toHaveLength(0)
    expect(afterDispatch?.childLinks[0]?.identity).toStrictEqual({
      runId: run.id,
      nodeName: 'content',
      caseKey: 'summary',
    })
    expect(afterDispatch?.childLinks[0]).toMatchObject({
      childKind: 'task',
      childName: task.name,
      taskName: task.name,
    })
    const childRunId = afterDispatch!.childLinks[0]!.childRunId
    expect(taskCommands[0]?.payload).toMatchObject({
      kind: 'taskAttempt',
      taskName: task.name,
      runId: childRunId,
      input: { scenario: 'alpha' },
    })

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [task.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [workflowImplementation],
      workerId: 'coordinator-1',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({ text: 'task:alpha' })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({ text: 'task:alpha' })
  })

  it('dispatches parallel activity members and completes with member outputs', async () => {
    const workflow = defineWorkflow({
      name: 'parallel-activity-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ summary: t.string(), review: t.string() }),
    })
      .parallel('sections', (helpers) => ({
        summary: helpers.activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        review: helpers.activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ status: t.string() }),
        }),
      }))
      .build()

    const implementation = implementWorkflow(workflow)
      .sections(({ activity }) => ({
        summary: activity(
          async (_ctx, input) => ({ text: `summary:${input.scenario}` }),
          {
            input: (_ctx, _outputs, input) => ({
              scenario: input.scenario,
            }),
          },
        ),
        review: activity(
          async (_ctx, input) => ({ status: `review:${input.scenario}` }),
          {
            input: (_ctx, _outputs, input) => ({
              scenario: input.scenario,
            }),
          },
        ),
      }))
      .finish((_ctx, { sections }) => ({
        summary: sections.summary.text,
        review: sections.review.status,
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const afterDispatch = await runtime.store.loadRunSnapshot(run.id)
    expect(afterDispatch?.nodes[0]?.status).toBe('waiting')
    expect(afterDispatch?.attempts).toHaveLength(2)
    expect(
      afterDispatch?.attempts.map((attempt) => attempt.identity),
    ).toStrictEqual([
      { runId: run.id, nodeName: 'sections', memberKey: 'summary' },
      { runId: run.id, nodeName: 'sections', memberKey: 'review' },
    ])
    expect(
      runtime.inspect().activityCommands.map((item) => item.payload),
    ).toMatchObject([
      {
        kind: 'activityAttempt',
        activityName: 'sections.summary',
        runId: run.id,
        nodeName: 'sections',
        input: { scenario: 'alpha' },
      },
      {
        kind: 'activityAttempt',
        activityName: 'sections.review',
        runId: run.id,
        nodeName: 'sections',
        input: { scenario: 'alpha' },
      },
    ])

    for (let index = 0; index < 2; index += 1) {
      const claimed = await runtime.attemptExecutor.claimActivity({
        workerId: 'activity-worker-1',
        workflowNames: [workflow.name],
        leaseMs: 30_000,
      })
      expect(claimed).not.toBeNull()

      await runActivityAttempt({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [implementation],
        workerId: 'activity-worker-1',
        claimed: claimed!,
      })
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      summary: { text: 'summary:alpha' },
      review: { status: 'review:alpha' },
    })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({
      summary: 'summary:alpha',
      review: 'review:alpha',
    })
  })

  it('does not complete a parallel node after only one activity member finishes', async () => {
    const workflow = defineWorkflow({
      name: 'parallel-activity-wait',
      input: t.object({ scenario: t.string() }),
      output: t.object({ ok: t.boolean() }),
    })
      .parallel('sections', (helpers) => ({
        first: helpers.activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        second: helpers.activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
      }))
      .build()

    const implementation = implementWorkflow(workflow)
      .sections(({ activity }) => ({
        first: activity(async (_ctx, input) => ({
          text: `first:${input.scenario}`,
        })),
        second: activity(async (_ctx, input) => ({
          text: `second:${input.scenario}`,
        })),
      }))
      .finish(() => ({ ok: true }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(snapshot?.run.status).toBe('queued')
    expect(
      snapshot?.attempts.filter((attempt) => attempt.status === 'completed'),
    ).toHaveLength(1)
  })

  it('runs parallel activity, task, and child workflow members', async () => {
    const embeddingTask = defineTask({
      name: 'parallel.embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const childWorkflow = defineWorkflow({
      name: 'parallel-child-content',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const workflow = defineWorkflow({
      name: 'parallel-mixed-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({
        summary: t.string(),
        embeddingId: t.string(),
        child: t.string(),
      }),
    })
      .parallel('sections', (helpers) => ({
        summary: helpers.activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        embedding: helpers.task(embeddingTask),
        child: helpers.workflow(childWorkflow),
      }))
      .build()

    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => ({ id: `embedding:${input.text}` }),
    })
    const childImplementation = implementWorkflow(childWorkflow).finish(
      (_ctx, _outputs, input) => ({ text: `child:${input.scenario}` }),
    )
    const implementation = implementWorkflow(workflow)
      .sections(({ activity, task, workflow }) => ({
        summary: activity(
          async (_ctx, input) => ({ text: `summary:${input.scenario}` }),
          {
            input: (_ctx, _outputs, input) => ({
              scenario: input.scenario,
            }),
          },
        ),
        embedding: task(embeddingTask, {
          input: (_ctx, _outputs, input) => ({ text: input.scenario }),
        }),
        child: workflow(childWorkflow, {
          input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        }),
      }))
      .finish((_ctx, { sections }) => ({
        summary: sections.summary.text,
        embeddingId: sections.embedding.id,
        child: sections.child.text,
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const parentCommand = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const afterDispatch = await runtime.store.loadRunSnapshot(run.id)
    expect(afterDispatch?.nodes[0]?.status).toBe('waiting')
    expect(
      afterDispatch?.attempts.map((attempt) => attempt.identity),
    ).toStrictEqual([
      { runId: run.id, nodeName: 'sections', memberKey: 'summary' },
    ])
    expect(
      afterDispatch?.childLinks.map((link) => link.identity),
    ).toStrictEqual([
      { runId: run.id, nodeName: 'sections', memberKey: 'embedding' },
      { runId: run.id, nodeName: 'sections', memberKey: 'child' },
    ])
    const embeddingRunId = afterDispatch!.childLinks.find(
      (link) => link.childKind === 'task',
    )!.childRunId
    const childRunId = afterDispatch!.childLinks.find(
      (link) => link.childKind === 'workflow',
    )!.childRunId

    const activityClaim = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(activityClaim).not.toBeNull()
    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: activityClaim!,
    })

    const taskClaim = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [embeddingTask.name],
      leaseMs: 30_000,
    })
    expect(taskClaim).not.toBeNull()
    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: taskClaim!,
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: {
        kind: 'continueRun',
        runId: childRunId,
        workflowName: childWorkflow.name,
      },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      summary: { text: 'summary:alpha' },
      embedding: { id: 'embedding:alpha' },
      child: { text: 'child:alpha' },
    })
    expect(
      (await runtime.store.loadRunSnapshot(embeddingRunId))?.run.status,
    ).toBe('completed')
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({
      summary: 'summary:alpha',
      embeddingId: 'embedding:alpha',
      child: 'child:alpha',
    })
  })

  it('cancels in-flight parallel child workflow siblings when a member fails', async () => {
    const childWorkflow = defineWorkflow({
      name: 'parallel-cancel-sibling-child',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const workflow = defineWorkflow({
      name: 'parallel-cancel-sibling-parent',
      input: t.object({ text: t.string() }),
      output: t.object({ ok: t.boolean() }),
    })
      .parallel('sections', (helpers) => ({
        fail: helpers.activity({
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        slow: helpers.workflow(childWorkflow),
      }))
      .build()
    const implementation = implementWorkflow(workflow)
      .sections(({ activity, workflow: child }) => ({
        fail: activity(async () => {
          throw new Error('parallel member failed')
        }),
        slow: child(childWorkflow, {
          input: (_ctx, _outputs, input) => ({ text: input.text }),
        }),
      }))
      .finish(() => ({ ok: true }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    const childRunId = (await runtime.store.loadRunSnapshot(run.id))
      ?.childLinks[0]?.childRunId
    expect(childRunId).toBeTypeOf('string')

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      activityNames: ['sections.fail'],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()
    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const parent = await runtime.store.loadRunSnapshot(run.id)
    const child = await runtime.store.loadRunSnapshot(childRunId!)
    expect(parent?.run.status).toBe('failed')
    expect(parent?.nodes[0]?.status).toBe('failed')
    expect(child?.run.status).toBe('cancelled')
  })

  it('runs mapTask wait-all items as child task runs and preserves item order', async () => {
    const embeddingTask = defineTask({
      name: 'map.embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'map-task-workflow',
      input: t.object({
        specs: t.array(t.object({ id: t.string(), text: t.string() })),
      }),
      output: t.object({ ids: t.array(t.string()) }),
    })
      .mapTask('embeddings', embeddingTask, {
        item: t.object({ id: t.string(), text: t.string() }),
        mode: 'wait-all',
      })
      .build()

    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => ({ id: `embedding:${input.text}` }),
    })
    let itemCalls = 0
    const implementation = implementWorkflow(workflow)
      .embeddings(embeddingTask, {
        items: (_ctx, _outputs, input) => {
          itemCalls += 1
          if (itemCalls > 1) throw new Error('items called twice')
          return input.specs
        },
        input: (_ctx, _outputs, item) => ({ text: item.text }),
      })
      .finish((_ctx, { embeddings }) => ({
        ids: embeddings.items.map((item) => item.output.id),
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: {
        specs: [
          { id: 'a', text: 'alpha' },
          { id: 'b', text: 'beta' },
        ],
      },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const waiting = await runtime.store.loadRunSnapshot(run.id)
    expect(itemCalls).toBe(1)
    expect(waiting?.nodes[0]?.status).toBe('waiting')
    expect(waiting?.mapItems.map((item) => item.item)).toStrictEqual([
      { id: 'a', text: 'alpha' },
      { id: 'b', text: 'beta' },
    ])
    expect(waiting?.childLinks.map((link) => link.identity)).toStrictEqual([
      { runId: run.id, nodeName: 'embeddings', itemIndex: 0 },
      { runId: run.id, nodeName: 'embeddings', itemIndex: 1 },
    ])
    expect(
      runtime.inspect().taskCommands.map((item) => item.payload.input),
    ).toStrictEqual([{ text: 'alpha' }, { text: 'beta' }])

    for (const _ of [0, 1]) {
      const claimed = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-1',
        taskNames: [embeddingTask.name],
        leaseMs: 30_000,
      })
      expect(claimed).not.toBeNull()
      await runTaskAttempt({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        tasks: [taskImplementation],
        workerId: 'task-worker-1',
        claimed: claimed!,
      })
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    const runIds = waiting!.childLinks.map((link) => link.childRunId)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        {
          item: { id: 'a', text: 'alpha' },
          index: 0,
          runId: runIds[0],
          output: { id: 'embedding:alpha' },
        },
        {
          item: { id: 'b', text: 'beta' },
          index: 1,
          runId: runIds[1],
          output: { id: 'embedding:beta' },
        },
      ],
    })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({
      ids: ['embedding:alpha', 'embedding:beta'],
    })
  })

  it('cancels in-flight mapTask siblings when a wait-all child fails', async () => {
    const embeddingTask = defineTask({
      name: 'map.cancel-sibling-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'map-cancel-sibling-workflow',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ ids: t.array(t.string()) }),
    })
      .mapTask('embeddings', embeddingTask, {
        item: t.string(),
        mode: 'wait-all',
      })
      .build()
    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => {
        if (input.text === 'bad') throw new Error('mapped task failed')
        return { id: `embedding:${input.text}` }
      },
    })
    const implementation = implementWorkflow(workflow)
      .embeddings(embeddingTask, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { embeddings }) => ({
        ids: embeddings.items.map((item) => item.output.id),
      }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { texts: ['bad', 'slow'] },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    const waiting = await runtime.store.loadRunSnapshot(run.id)
    const failedRunId = waiting!.childLinks[0]!.childRunId
    const siblingRunId = waiting!.childLinks[1]!.childRunId
    expect(runtime.inspect().taskCommands).toHaveLength(2)

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [embeddingTask.name],
      leaseMs: 30_000,
    })
    expect(claimed?.command.runId).toBe(failedRunId)
    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const parent = await runtime.store.loadRunSnapshot(run.id)
    const failedChild = await runtime.store.loadRunSnapshot(failedRunId)
    const sibling = await runtime.store.loadRunSnapshot(siblingRunId)
    expect(parent?.run.status).toBe('failed')
    expect(parent?.nodes[0]?.status).toBe('failed')
    expect(failedChild?.run.status).toBe('failed')
    expect(sibling?.run.status).toBe('cancelled')
    expect(sibling?.nodes[0]?.status).toBe('cancelled')
    expect(runtime.inspect().taskCommands).toStrictEqual([])
  })

  it('bounds mapTask child run dispatch by node concurrency', async () => {
    const embeddingTask = defineTask({
      name: 'map.bounded-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'map-task-bounded-workflow',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ ids: t.array(t.string()) }),
    })
      .mapTask('embeddings', embeddingTask, {
        item: t.string(),
        mode: 'wait-all',
        concurrency: 2,
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .embeddings(embeddingTask, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { embeddings }) => ({
        ids: embeddings.items.map((item) => item.output.id),
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { texts: ['alpha', 'beta', 'gamma'] },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const firstBatch = await runtime.store.loadRunSnapshot(run.id)
    expect(firstBatch?.nodes[0]?.status).toBe('waiting')
    expect(firstBatch?.childLinks.map((link) => link.itemIndex)).toStrictEqual([
      0, 1,
    ])

    await runtime.store.completeRun({
      runId: firstBatch!.childLinks[0]!.childRunId,
      output: { id: 'embedding:alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const secondBatch = await runtime.store.loadRunSnapshot(run.id)
    expect(secondBatch?.nodes[0]?.status).toBe('waiting')
    expect(secondBatch?.childLinks.map((link) => link.itemIndex)).toStrictEqual(
      [0, 1, 2],
    )

    await runtime.store.completeRun({
      runId: secondBatch!.childLinks[1]!.childRunId,
      output: { id: 'embedding:beta' },
    })
    await runtime.store.completeRun({
      runId: secondBatch!.childLinks[2]!.childRunId,
      output: { id: 'embedding:gamma' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    const runIds = final!.childLinks.map((link) => link.childRunId)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        {
          item: 'alpha',
          index: 0,
          runId: runIds[0],
          output: { id: 'embedding:alpha' },
        },
        {
          item: 'beta',
          index: 1,
          runId: runIds[1],
          output: { id: 'embedding:beta' },
        },
        {
          item: 'gamma',
          index: 2,
          runId: runIds[2],
          output: { id: 'embedding:gamma' },
        },
      ],
    })
    expect(final?.run.output).toStrictEqual({
      ids: ['embedding:alpha', 'embedding:beta', 'embedding:gamma'],
    })
  })

  it('runs mapTask wait-settled items without failing parent on item failure', async () => {
    const embeddingTask = defineTask({
      name: 'map.settled-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'map-task-settled-workflow',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ count: t.number() }),
    })
      .mapTask('embeddings', embeddingTask, {
        item: t.string(),
        mode: 'wait-settled',
      })
      .build()

    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => {
        if (input.text === 'beta') {
          throw new Error('bad embedding', {
            cause: new Error('embedding service down'),
          })
        }
        return { id: `embedding:${input.text}` }
      },
    })
    const implementation = implementWorkflow(workflow)
      .embeddings(embeddingTask, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { embeddings }) => ({ count: embeddings.items.length }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { texts: ['alpha', 'beta'] },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    for (const _ of [0, 1]) {
      const claimed = await runtime.attemptExecutor.claimTask({
        workerId: 'task-worker-1',
        taskNames: [embeddingTask.name],
        leaseMs: 30_000,
      })
      expect(claimed).not.toBeNull()
      await runTaskAttempt({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        tasks: [taskImplementation],
        workerId: 'task-worker-1',
        claimed: claimed!,
      })
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    const runIds = final!.childLinks.map((link) => link.childRunId)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toMatchObject({
      items: [
        {
          item: 'alpha',
          index: 0,
          runId: runIds[0],
          status: 'completed',
          output: { id: 'embedding:alpha' },
        },
        {
          item: 'beta',
          index: 1,
          runId: runIds[1],
          status: 'failed',
          error: {
            message: 'bad embedding',
            cause: { message: 'embedding service down' },
          },
        },
      ],
    })
    expect(JSON.stringify(final?.nodes[0]?.output)).toContain(
      'embedding service down',
    )
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({ count: 2 })
  })

  it('runs mapTask start-only and completes after child task runs are started', async () => {
    const embeddingTask = defineTask({
      name: 'map.start-only-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'map-task-start-only-workflow',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ started: t.number() }),
    })
      .mapTask('embeddings', embeddingTask, {
        item: t.string(),
        mode: 'start-only',
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .embeddings(embeddingTask, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { embeddings }) => ({ started: embeddings.items.length }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { texts: ['alpha', 'beta'] },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    const runIds = final!.childLinks.map((link) => link.childRunId)
    expect(runtime.inspect().taskCommands).toHaveLength(2)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        { item: 'alpha', index: 0, runId: runIds[0], status: 'queued' },
        { item: 'beta', index: 1, runId: runIds[1], status: 'queued' },
      ],
    })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({ started: 2 })
  })

  it('runs mapTask start-only concurrency as start batches without waiting for child completion', async () => {
    const embeddingTask = defineTask({
      name: 'map.start-only-batched-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'map-task-start-only-batched-workflow',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ started: t.number() }),
    })
      .mapTask('embeddings', embeddingTask, {
        item: t.string(),
        mode: 'start-only',
        concurrency: 1,
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .embeddings(embeddingTask, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { embeddings }) => ({ started: embeddings.items.length }))

    const runtime = createInMemoryWorkflowRuntime()
    const command = {
      kind: 'continueRun' as const,
      runId: (
        await runtime.store.createRun({
          workflowName: workflow.name,
          input: { texts: ['alpha', 'beta'] },
        })
      ).id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const firstBatch = await runtime.store.loadRunSnapshot(command.runId)
    expect(firstBatch?.nodes[0]?.status).toBe('waiting')
    expect(firstBatch?.childLinks.map((link) => link.itemIndex)).toStrictEqual([
      0,
    ])
    expect(
      runtime
        .inspect()
        .continueRunCommands.some(
          (queued) => queued.payload.runId === command.runId,
        ),
    ).toBe(true)

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(command.runId)
    const runIds = final!.childLinks.map((link) => link.childRunId)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        { item: 'alpha', index: 0, runId: runIds[0], status: 'queued' },
        { item: 'beta', index: 1, runId: runIds[1], status: 'queued' },
      ],
    })
    expect(final?.run.output).toStrictEqual({ started: 2 })
  })

  it('runs mapWorkflow wait-all children on separate workers and preserves item order', async () => {
    const childWorkflow = defineWorkflow({
      name: 'map-child-content',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'map-workflow-parent',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ ids: t.array(t.string()) }),
    })
      .mapWorkflow('children', childWorkflow, {
        item: t.string(),
        mode: 'wait-all',
      })
      .build()

    const childImplementation = implementWorkflow(childWorkflow).finish(
      (_ctx, _outputs, input) => ({ id: `child:${input.text}` }),
    )
    let itemCalls = 0
    const parentImplementation = implementWorkflow(parentWorkflow)
      .children(childWorkflow, {
        items: (_ctx, _outputs, input) => {
          itemCalls += 1
          if (itemCalls > 1) throw new Error('items called twice')
          return input.texts
        },
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { children }) => ({
        ids: children.items.map((item) => item.output.id),
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { texts: ['alpha', 'beta'] },
    })
    const parentCommand = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const waiting = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(itemCalls).toBe(1)
    expect(waiting?.nodes[0]?.status).toBe('waiting')
    expect(waiting?.childLinks.map((link) => link.identity)).toStrictEqual([
      { runId: parentRun.id, nodeName: 'children', itemIndex: 0 },
      { runId: parentRun.id, nodeName: 'children', itemIndex: 1 },
    ])
    const childRunIds = waiting!.childLinks.map((link) => link.childRunId)

    for (const childRunId of childRunIds) {
      await continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [childImplementation],
        workerId: 'child-coordinator',
        command: {
          kind: 'continueRun',
          runId: childRunId,
          workflowName: childWorkflow.name,
        },
      })
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const final = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        {
          item: 'alpha',
          index: 0,
          runId: childRunIds[0],
          output: { id: 'child:alpha' },
        },
        {
          item: 'beta',
          index: 1,
          runId: childRunIds[1],
          output: { id: 'child:beta' },
        },
      ],
    })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({
      ids: ['child:alpha', 'child:beta'],
    })
  })

  it('bounds mapWorkflow child run dispatch by node concurrency', async () => {
    const childWorkflow = defineWorkflow({
      name: 'map-bounded-child',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'map-workflow-bounded-parent',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ ids: t.array(t.string()) }),
    })
      .mapWorkflow('children', childWorkflow, {
        item: t.string(),
        mode: 'wait-all',
        concurrency: 2,
      })
      .build()

    const parentImplementation = implementWorkflow(parentWorkflow)
      .children(childWorkflow, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { children }) => ({
        ids: children.items.map((item) => item.output.id),
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { texts: ['alpha', 'beta', 'gamma'] },
    })
    const parentCommand = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const firstBatch = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(firstBatch?.nodes[0]?.status).toBe('waiting')
    expect(firstBatch?.childLinks.map((link) => link.itemIndex)).toStrictEqual([
      0, 1,
    ])

    await runtime.store.completeRun({
      runId: firstBatch!.childLinks[0]!.childRunId,
      output: { id: 'child:alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const secondBatch = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(secondBatch?.nodes[0]?.status).toBe('waiting')
    expect(secondBatch?.childLinks.map((link) => link.itemIndex)).toStrictEqual(
      [0, 1, 2],
    )

    await runtime.store.completeRun({
      runId: secondBatch!.childLinks[1]!.childRunId,
      output: { id: 'child:beta' },
    })
    await runtime.store.completeRun({
      runId: secondBatch!.childLinks[2]!.childRunId,
      output: { id: 'child:gamma' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const final = await runtime.store.loadRunSnapshot(parentRun.id)
    const runIds = final!.childLinks.map((link) => link.childRunId)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        {
          item: 'alpha',
          index: 0,
          runId: runIds[0],
          output: { id: 'child:alpha' },
        },
        {
          item: 'beta',
          index: 1,
          runId: runIds[1],
          output: { id: 'child:beta' },
        },
        {
          item: 'gamma',
          index: 2,
          runId: runIds[2],
          output: { id: 'child:gamma' },
        },
      ],
    })
    expect(final?.run.output).toStrictEqual({
      ids: ['child:alpha', 'child:beta', 'child:gamma'],
    })
  })

  it('runs mapWorkflow wait-settled without failing parent on child failure', async () => {
    const childWorkflow = defineWorkflow({
      name: 'map-settled-child',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'map-workflow-settled-parent',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ count: t.number() }),
    })
      .mapWorkflow('children', childWorkflow, {
        item: t.string(),
        mode: 'wait-settled',
      })
      .build()

    const parentImplementation = implementWorkflow(parentWorkflow)
      .children(childWorkflow, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { children }) => ({ count: children.items.length }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { texts: ['alpha', 'beta'] },
    })
    const parentCommand = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const waiting = await runtime.store.loadRunSnapshot(parentRun.id)
    const childRunIds = waiting!.childLinks.map((link) => link.childRunId)
    await runtime.store.completeRun({
      runId: childRunIds[0]!,
      output: { id: 'child:alpha' },
    })
    await runtime.store.failRun({
      runId: childRunIds[1]!,
      error: new Error('child failed', {
        cause: new Error('child cause'),
      }),
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: parentCommand,
    })

    const final = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toMatchObject({
      items: [
        {
          item: 'alpha',
          index: 0,
          runId: childRunIds[0],
          status: 'completed',
          output: { id: 'child:alpha' },
        },
        {
          item: 'beta',
          index: 1,
          runId: childRunIds[1],
          status: 'failed',
          error: {
            message: 'child failed',
            cause: { message: 'child cause' },
          },
        },
      ],
    })
    expect(JSON.stringify(final?.nodes[0]?.output)).toContain('child cause')
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({ count: 2 })
  })

  it('runs mapWorkflow start-only and completes after child workflow runs are started', async () => {
    const childWorkflow = defineWorkflow({
      name: 'map-start-only-child',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'map-workflow-start-only-parent',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ started: t.number() }),
    })
      .mapWorkflow('children', childWorkflow, {
        item: t.string(),
        mode: 'start-only',
      })
      .build()

    const parentImplementation = implementWorkflow(parentWorkflow)
      .children(childWorkflow, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { children }) => ({ started: children.items.length }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { texts: ['alpha', 'beta'] },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: parentWorkflow.name,
      },
    })

    const final = await runtime.store.loadRunSnapshot(run.id)
    const runIds = final!.childLinks.map((link) => link.childRunId)
    expect(
      runtime
        .inspect()
        .continueRunCommands.filter(
          (command) => command.payload.workflowName === childWorkflow.name,
        ),
    ).toHaveLength(2)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        { item: 'alpha', index: 0, runId: runIds[0], status: 'queued' },
        { item: 'beta', index: 1, runId: runIds[1], status: 'queued' },
      ],
    })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({ started: 2 })
  })

  it('runs mapWorkflow start-only concurrency as start batches without waiting for child completion', async () => {
    const childWorkflow = defineWorkflow({
      name: 'map-start-only-batched-child',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'map-workflow-start-only-batched-parent',
      input: t.object({ texts: t.array(t.string()) }),
      output: t.object({ started: t.number() }),
    })
      .mapWorkflow('children', childWorkflow, {
        item: t.string(),
        mode: 'start-only',
        concurrency: 1,
      })
      .build()

    const parentImplementation = implementWorkflow(parentWorkflow)
      .children(childWorkflow, {
        items: (_ctx, _outputs, input) => input.texts,
        input: (_ctx, _outputs, item) => ({ text: item }),
      })
      .finish((_ctx, { children }) => ({ started: children.items.length }))

    const runtime = createInMemoryWorkflowRuntime()
    const command = {
      kind: 'continueRun' as const,
      runId: (
        await runtime.store.createRun({
          workflowName: parentWorkflow.name,
          input: { texts: ['alpha', 'beta'] },
        })
      ).id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command,
    })

    const firstBatch = await runtime.store.loadRunSnapshot(command.runId)
    expect(firstBatch?.nodes[0]?.status).toBe('waiting')
    expect(firstBatch?.childLinks.map((link) => link.itemIndex)).toStrictEqual([
      0,
    ])
    expect(
      runtime
        .inspect()
        .continueRunCommands.some(
          (queued) => queued.payload.runId === command.runId,
        ),
    ).toBe(true)

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command,
    })

    const final = await runtime.store.loadRunSnapshot(command.runId)
    const runIds = final!.childLinks.map((link) => link.childRunId)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({
      items: [
        { item: 'alpha', index: 0, runId: runIds[0], status: 'queued' },
        { item: 'beta', index: 1, runId: runIds[1], status: 'queued' },
      ],
    })
    expect(final?.run.output).toStrictEqual({ started: 2 })
  })

  it('reuses original branch child task run input on repeated continuation', async () => {
    const task = defineTask({
      name: 'branch.stable-summary',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'branch-task-input-reuse',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          summary: helpers.task(task),
        }),
      })
      .build()

    let mapCalls = 0
    const implementation = implementWorkflow(workflow)
      .content({
        select: () => 'summary',
        cases: (helpers) => ({
          summary: helpers.task(task, {
            input: (_ctx, _outputs, input) => {
              mapCalls += 1
              if (mapCalls > 1) throw new Error('task mapper called twice')
              return { scenario: `${input.scenario}-${mapCalls}` }
            },
          }),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = snapshot!.childLinks[0]!.childRunId
    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId)
    const taskCommands = runtime.inspect().taskCommands
    const attemptId = taskCommands[0]?.payload.attemptId
    expect(mapCalls).toBe(1)
    expect(snapshot?.nodes[0]?.input).toStrictEqual({ scenario: 'alpha-1' })
    expect(snapshot?.attempts).toHaveLength(0)
    expect(snapshot?.childLinks).toHaveLength(1)
    expect(childSnapshot?.run.input).toStrictEqual({ scenario: 'alpha-1' })
    expect(childSnapshot?.attempts).toHaveLength(1)
    expect(childSnapshot?.attempts[0]?.input).toStrictEqual({
      scenario: 'alpha-1',
    })
    expect(taskCommands).toHaveLength(1)
    expect(taskCommands.map((item) => item.payload.attemptId)).toEqual([
      attemptId,
    ])
    expect(taskCommands.map((item) => item.payload.input)).toStrictEqual([
      { scenario: 'alpha-1' },
    ])
  })

  it('preserves a started branch child task attempt without duplicating its command', async () => {
    const task = defineTask({
      name: 'branch.redispatch-summary',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'branch-task-redispatch-failure',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          summary: helpers.task(task),
        }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content({
        select: () => 'summary',
        cases: (helpers) => ({
          summary: helpers.task(task),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: run.id,
      workflowName: workflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command,
    })
    expect(runtime.inspect().taskCommands).toHaveLength(1)

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [implementation],
        workerId: 'coordinator-1',
        command,
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = snapshot!.childLinks[0]!.childRunId
    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(snapshot?.attempts).toHaveLength(0)
    expect(childSnapshot?.run.status).toBe('queued')
    expect(childSnapshot?.nodes[0]?.status).toBe('running')
    expect(childSnapshot?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().taskCommands).toHaveLength(1)
  })

  it('runs a branch child workflow case on a separate worker', async () => {
    const childWorkflow = defineWorkflow({
      name: 'branch-child-content',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'branch-child-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow),
        }),
      })
      .build()

    const childImplementation = implementWorkflow(childWorkflow).finish(
      (_ctx, _outputs, input) => ({ text: `child:${input.scenario}` }),
    )
    const parentImplementation = implementWorkflow(parentWorkflow)
      .content({
        select: () => 'child',
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow, {
            input: (_ctx, _outputs, input) => ({
              scenario: input.scenario,
            }),
          }),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const parentWaiting = await runtime.store.loadRunSnapshot(parentRun.id)
    const link = parentWaiting!.childLinks[0]!
    expect(parentWaiting?.nodes[0]?.status).toBe('waiting')
    expect(link.caseKey).toBe('child')
    expect(link.workflowName).toBe(childWorkflow.name)

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: {
        kind: 'continueRun',
        runId: link.childRunId,
        workflowName: childWorkflow.name,
      },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const final = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(final?.nodes[0]?.status).toBe('completed')
    expect(final?.nodes[0]?.output).toStrictEqual({ text: 'child:alpha' })
    expect(final?.run.status).toBe('completed')
    expect(final?.run.output).toStrictEqual({ text: 'child:alpha' })
  })

  it('fails the run when a branch selects an unknown case', async () => {
    const workflow = defineWorkflow({
      name: 'branch-unknown-case',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          normal: helpers.activity({
            input: t.object({ scenario: t.string() }),
            output: t.object({ text: t.string() }),
          }),
        }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content({
        select: () => 'missing' as 'normal',
        cases: (helpers) => ({
          normal: helpers.activity(async (_ctx, input) => ({
            text: input.scenario,
          })),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.selectedCase).toBe('missing')
    expect(snapshot?.run.status).toBe('failed')
  })

  it('fails the run when workflow finish throws', async () => {
    const workflow = defineWorkflow({
      name: 'finish-throws-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(() => {
      throw new Error('finish failed')
    })
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('failed')
    expect(snapshot?.run.error?.message).toBe('finish failed')
  })

  it('fails the run when an activity input mapper throws', async () => {
    const workflow = defineWorkflow({
      name: 'activity-input-throws-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: () => {
          throw new Error('input mapper failed')
        },
      })
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe('input mapper failed')
    expect(snapshot?.run.status).toBe('failed')
  })

  it('fails the run when mapped activity input fails its schema', async () => {
    const workflow = defineWorkflow({
      name: 'activity-input-schema-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    let handlerCalled = false
    const implementation = implementWorkflow(workflow)
      .content(
        async (_ctx, input) => {
          handlerCalled = true
          return { text: input.scenario }
        },
        {
          input: () => ({ scenario: 123 }) as never,
        },
      )
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe(
      'Invalid activity input [activity-input-schema-workflow.content]',
    )
    expect(snapshot?.run.status).toBe('failed')
    expect(handlerCalled).toBe(false)
    expect(runtime.inspect().activityCommands).toStrictEqual([])
  })

  it('decodes mapped activity input before resolving activity idempotency', async () => {
    const workflow = defineWorkflow({
      name: 'activity-input-decode-before-idempotency-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    let idempotencyCalls = 0
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: () => ({ scenario: 123 }) as never,
        idempotency: () => {
          idempotencyCalls += 1
          throw new Error('idempotency should not run')
        },
      })
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(idempotencyCalls).toBe(0)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe(
      'Invalid activity input [activity-input-decode-before-idempotency-workflow.content]',
    )
    expect(snapshot?.run.status).toBe('failed')
    expect(runtime.inspect().activityCommands).toStrictEqual([])
  })

  it('fails the run when an activity idempotency mapper throws', async () => {
    const workflow = defineWorkflow({
      name: 'activity-idempotency-throws-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
        idempotency: () => {
          throw new Error('idempotency mapper failed')
        },
      })
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe('idempotency mapper failed')
    expect(snapshot?.run.status).toBe('failed')
  })

  it('fails the run when a map items mapper throws', async () => {
    const task = defineTask({
      name: 'items-throws-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'map-items-throws-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ ids: t.array(t.string()) }),
    })
      .mapTask('embeddings', task, {
        item: t.object({ text: t.string() }),
        mode: 'wait-all',
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .embeddings(task, {
        items: () => {
          throw new Error('items mapper failed')
        },
        input: (_ctx, _outputs, item) => ({ text: item.text }),
      })
      .finish((_ctx, { embeddings }) => ({
        ids: embeddings.items.map((item) => item.output.id),
      }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).resolves.toStrictEqual({ status: 'processed' })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe('items mapper failed')
    expect(snapshot?.run.status).toBe('failed')
  })

  it('re-enqueues a branch child workflow when enqueue fails after link creation', async () => {
    const childWorkflow = defineWorkflow({
      name: 'branch-recover-child-enqueue-child',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'branch-recover-child-enqueue-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow),
        }),
      })
      .build()
    const parentImplementation = implementWorkflow(parentWorkflow)
      .content({
        select: () => 'child',
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow, {
            input: (_ctx, _outputs, input) => ({
              scenario: input.scenario,
            }),
          }),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }
    let throwChildEnqueue = true
    const runCoordinationExecutor = {
      ...runtime.runCoordinationExecutor,
      enqueue: async (queuedCommand) => {
        if (
          throwChildEnqueue &&
          queuedCommand.workflowName === childWorkflow.name
        ) {
          throwChildEnqueue = false
          throw new Error('child enqueue failed')
        }

        await runtime.runCoordinationExecutor.enqueue(queuedCommand)
      },
    } satisfies typeof runtime.runCoordinationExecutor

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [parentImplementation],
        workerId: 'parent-coordinator',
        command,
      }),
    ).rejects.toThrow('child enqueue failed')

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    const childLink = snapshot?.childLinks[0]
    expect(snapshot?.nodes[0]?.selectedCase).toBe('child')
    expect(snapshot?.childLinks).toHaveLength(1)
    expect(
      runtime
        .inspect()
        .runs.filter((run) => run.workflowName === childWorkflow.name),
    ).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: childLink?.childRunId,
          workflowName: childWorkflow.name,
        },
      },
    ])
  })

  it('retries parent wake for a completed branch child workflow', async () => {
    const childWorkflow = defineWorkflow({
      name: 'branch-recover-parent-wake-child',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'branch-recover-parent-wake-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow),
        }),
      })
      .build()
    const childImplementation = implementWorkflow(childWorkflow).finish(
      (_ctx, _outputs, input) => ({ text: `child:${input.scenario}` }),
    )
    const parentImplementation = implementWorkflow(parentWorkflow)
      .content({
        select: () => 'child',
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow, {
            input: (_ctx, _outputs, input) => ({
              scenario: input.scenario,
            }),
          }),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const started = await runtime.store.loadRunSnapshot(parentRun.id)
    const childRunId = started!.childLinks[0]!.childRunId
    let throwParentEnqueue = true
    const runCoordinationExecutor = {
      ...runtime.runCoordinationExecutor,
      enqueue: async (queuedCommand) => {
        if (
          throwParentEnqueue &&
          queuedCommand.runId === parentRun.id &&
          queuedCommand.workflowName === parentWorkflow.name
        ) {
          throwParentEnqueue = false
          throw new Error('parent wake failed')
        }

        await runtime.runCoordinationExecutor.enqueue(queuedCommand)
      },
    } satisfies typeof runtime.runCoordinationExecutor
    const childCommand = {
      kind: 'continueRun' as const,
      runId: childRunId,
      workflowName: childWorkflow.name,
    }

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [childImplementation],
        workerId: 'child-coordinator',
        command: childCommand,
      }),
    ).rejects.toThrow('parent wake failed')

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: childCommand,
    })

    expect(
      runtime
        .inspect()
        .continueRunCommands.some(
          (queuedCommand) =>
            queuedCommand.payload.runId === parentRun.id &&
            queuedCommand.payload.workflowName === parentWorkflow.name,
        ),
    ).toBe(true)
  })

  it('does not remap branch child workflow input after link exists', async () => {
    const childWorkflow = defineWorkflow({
      name: 'branch-remap-child',
      input: t.unknown(),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'branch-remap-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow),
        }),
      })
      .build()

    let mapCalls = 0
    const implementation = implementWorkflow(parentWorkflow)
      .content({
        select: () => 'child',
        cases: (helpers) => ({
          child: helpers.workflow(childWorkflow, {
            input: () => {
              mapCalls += 1
              if (mapCalls > 1) throw new Error('mapper called twice')
              return undefined
            },
          }),
        }),
      })
      .finish((_ctx, { content }) => ({ text: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'parent-coordinator',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'parent-coordinator',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    const childLink = snapshot?.childLinks[0]
    expect(mapCalls).toBe(1)
    expect(snapshot?.nodes[0]).toHaveProperty('input', undefined)
    expect(snapshot?.childLinks).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: childLink?.childRunId,
          workflowName: childWorkflow.name,
        },
      },
    ])
  })

  it('releases a claimed activity attempt when no workflow implementation is registered', async () => {
    const workflow = defineWorkflow({
      name: 'unrouted-activity-worker',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().activityCommands).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('acks a claimed activity attempt when the attempt lease token is stale', async () => {
    const workflow = defineWorkflow({
      name: 'stale-activity-worker',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: {
        ...claimed!,
        command: {
          ...claimed!.command,
          leaseToken: 'stale-attempt-token',
        },
      },
    })

    await runtime.attemptExecutor.release(claimed!)

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().activityCommands).toHaveLength(0)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('wakes the coordinator for a completed stale parallel activity member', async () => {
    let handlerCalls = 0
    const workflow = defineWorkflow({
      name: 'stale-parallel-activity-worker',
      input: t.object({ scenario: t.string() }),
      output: t.object({ summary: t.string(), review: t.string() }),
    })
      .parallel('sections', (helpers) => ({
        summary: helpers.activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        review: helpers.activity({
          input: t.object({ scenario: t.string() }),
          output: t.object({ status: t.string() }),
        }),
      }))
      .build()

    const implementation = implementWorkflow(workflow)
      .sections(({ activity }) => ({
        summary: activity(async (_ctx, input) => {
          handlerCalls += 1
          return { text: `summary:${input.scenario}` }
        }),
        review: activity(async (_ctx, input) => {
          handlerCalls += 1
          return { status: `review:${input.scenario}` }
        }),
      }))
      .finish((_ctx, { sections }) => ({
        summary: sections.summary.text,
        review: sections.review.status,
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runtime.store.completeCurrentAttempt({
      attemptId: claimed!.command.attemptId,
      leaseToken: claimed!.command.leaseToken,
      output: { text: 'summary:alpha' },
    })

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(handlerCalls).toBe(0)
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(runtime.inspect().activityCommands).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      },
    ])
  })

  it('acks a superseded activity attempt without running its handler', async () => {
    let handlerCalls = 0
    const workflow = defineWorkflow({
      name: 'superseded-activity-worker',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => {
        handlerCalls += 1
        return { text: input.scenario }
      })
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'beta' },
    })

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    await runtime.attemptExecutor.release(claimed!)

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(handlerCalls).toBe(0)
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.nodes[0]?.currentAttemptId).toBe(secondAttempt.id)
    expect(snapshot?.nodes[0]?.output).toBeUndefined()
    expect(runtime.inspect().activityCommands).toHaveLength(0)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('does not mark a successful handler as failed when continuation enqueue throws', async () => {
    const workflow = defineWorkflow({
      name: 'enqueue-failure-activity-worker',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: [workflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await expect(
      runActivityAttempt({
        store: runtime.store,
        runCoordinationExecutor: {
          ...runtime.runCoordinationExecutor,
          enqueue: async () => {
            throw new Error('continue enqueue down')
          },
        },
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [implementation],
        workerId: 'activity-worker-1',
        claimed: claimed!,
      }),
    ).rejects.toThrow('continue enqueue down')

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.attempts[0]?.status).toBe('completed')
    expect(snapshot?.nodes[0]?.status).toBe('completed')
    expect(snapshot?.nodes[0]?.output).toStrictEqual({ text: 'alpha' })
  })

  it('releases current activity attempts with missing workflow implementations', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'missing-workflow',
      input: { scenario: 'alpha' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    const attempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { scenario: 'alpha' },
    })
    await runtime.attemptExecutor.dispatchActivity({
      kind: 'activityAttempt',
      workflowName: 'missing-workflow',
      activityName: 'content',
      runId: run.id,
      nodeName: 'content',
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: { scenario: 'alpha' },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-1',
      workflowNames: ['missing-workflow'],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [],
      workerId: 'activity-worker-1',
      claimed: claimed!,
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.attempts[0]?.status).toBe('started')
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(runtime.inspect().activityCommands).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([])
  })

  it('leaves the run non-terminal when dispatching the activity fails', async () => {
    const workflow = defineWorkflow({
      name: 'dispatch-failure',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const error = new Error('queue down')

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchActivity: async () => {
            throw error
          },
        },
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'coordinator-1',
        command: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      }),
    ).rejects.toThrow('queue down')

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.attempts[0]?.status).toBe('started')
  })

  it('passes resolved workflow dependency context to mappers and finish', async () => {
    const prefix = createValueInjectable('case')
    const workflow = defineWorkflow({
      name: 'dependency-context',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow, {
      dependencies: { prefix },
    })
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (ctx, _outputs, input) => ({
          scenario: `${ctx.prefix}:${input.scenario}`,
        }),
      })
      .finish((ctx, { content }) => ({
        caseId: `${ctx.prefix}:${content.text}`,
      }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const afterDispatch = runtime.inspect()
    expect(afterDispatch.nodes[0]?.input).toStrictEqual({
      scenario: 'case:alpha',
    })

    const attempt = afterDispatch.attempts[0]!
    await runtime.store.completeCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      output: { text: 'content' },
    })
    await runtime.store.completeNode({
      runId: run.id,
      nodeName: 'content',
      output: { text: 'content' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.output).toStrictEqual({ caseId: 'case:content' })
  })

  it('fails the run instead of re-dispatching a failed node', async () => {
    const workflow = defineWorkflow({
      name: 'failed-node',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    await runtime.store.createNode({
      runId: run.id,
      name: 'content',
      kind: 'activity',
    })
    await runtime.store.failNode({
      runId: run.id,
      nodeName: 'content',
      error: new Error('activity failed'),
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(runtime.inspect().activityCommands).toHaveLength(0)
    expect(snapshot?.run.status).toBe('failed')
    expect(snapshot?.nodes[0]?.status).toBe('failed')
  })

  it('starts a child task run, runs it, and completes parent after continuation', async () => {
    const embeddingTask = defineTask({
      name: 'embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
    const workflow = defineWorkflow({
      name: 'task-worker',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
      .task('embedding', embeddingTask)
      .build()

    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => ({ vector: [input.text.length] }),
    })
    const implementation = implementWorkflow(workflow)
      .embedding(embeddingTask, {
        input: (_ctx, _outputs, input) => ({ text: input.text }),
      })
      .finish((_ctx, { embedding }) => ({ vector: embedding.vector }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const parentWaiting = await runtime.store.loadRunSnapshot(run.id)
    const childLink = parentWaiting?.childLinks[0]
    expect(parentWaiting?.nodes[0]?.status).toBe('waiting')
    expect(parentWaiting?.attempts).toHaveLength(0)
    expect(childLink).toMatchObject({
      childKind: 'task',
      childName: embeddingTask.name,
      taskName: embeddingTask.name,
      parentRunId: run.id,
      parentNodeName: 'embedding',
    })

    const childRunId = childLink!.childRunId
    const childWaiting = await runtime.store.loadRunSnapshot(childRunId)
    expect(childWaiting?.run).toMatchObject({
      id: childRunId,
      kind: 'task',
      name: embeddingTask.name,
      taskName: embeddingTask.name,
      input: { text: 'alpha' },
      parentRunId: run.id,
      parentNodeName: 'embedding',
    })

    const afterDispatch = runtime.inspect()
    expect(afterDispatch.taskCommands).toHaveLength(1)
    expect(afterDispatch.taskCommands[0]?.payload).toMatchObject({
      kind: 'taskAttempt',
      taskName: 'embedding.generate',
      runId: childRunId,
      input: { text: 'alpha' },
    })

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [embeddingTask.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })

    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      },
    ])

    const completedChild = await runtime.store.loadRunSnapshot(childRunId)
    expect(completedChild?.run.status).toBe('completed')
    expect(completedChild?.run.output).toStrictEqual({ vector: [5] })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('completed')
    expect(snapshot?.run.output).toStrictEqual({ vector: [5] })
  })

  it('acks a stale task attempt without running its handler', async () => {
    let handlerCalls = 0
    const embeddingTask = defineTask({
      name: 'stale.embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
    const workflow = defineWorkflow({
      name: 'stale-task-worker',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
      .task('embedding', embeddingTask)
      .build()

    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => {
        handlerCalls += 1
        return { vector: [input.text.length] }
      },
    })
    const implementation = implementWorkflow(workflow)
      .embedding(embeddingTask)
      .finish((_ctx, { embedding }) => ({ vector: embedding.vector }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [embeddingTask.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: {
        ...claimed!,
        command: {
          ...claimed!.command,
          leaseToken: 'stale-attempt-token',
        },
      },
    })

    await runtime.attemptExecutor.release(claimed!)

    const parentSnapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = parentSnapshot!.childLinks[0]!.childRunId
    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId)
    expect(handlerCalls).toBe(0)
    expect(parentSnapshot?.nodes[0]?.status).toBe('waiting')
    expect(childSnapshot?.nodes[0]?.status).toBe('waiting')
    expect(childSnapshot?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().taskCommands).toHaveLength(0)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('releases a task attempt when the worker has no matching task implementation', async () => {
    const embeddingTask = defineTask({
      name: 'validated.embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
    const workflow = defineWorkflow({
      name: 'validated-task-worker',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
      .task('embedding', embeddingTask)
      .build()

    const implementation = implementWorkflow(workflow)
      .embedding(embeddingTask)
      .finish((_ctx, { embedding }) => ({ vector: embedding.vector }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [embeddingTask.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    const taskCommand = claimed!.command
    if (taskCommand.kind !== 'taskAttempt') {
      throw new Error(`Unexpected command kind [${taskCommand.kind}]`)
    }

    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })

    const parentSnapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = parentSnapshot!.childLinks[0]!.childRunId
    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId)
    expect(taskCommand.taskName).toBe(embeddingTask.name)
    expect(parentSnapshot?.nodes[0]?.status).toBe('waiting')
    expect(childSnapshot?.nodes[0]?.status).toBe('waiting')
    expect(childSnapshot?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().taskCommands).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('reconciles a completed stale task attempt before acking it', async () => {
    let handlerCalls = 0
    const embeddingTask = defineTask({
      name: 'reconciled.embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
    const workflow = defineWorkflow({
      name: 'reconciled-task-worker',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
      .task('embedding', embeddingTask)
      .build()

    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => {
        handlerCalls += 1
        return { vector: [input.text.length] }
      },
    })
    const implementation = implementWorkflow(workflow)
      .embedding(embeddingTask)
      .finish((_ctx, { embedding }) => ({ vector: embedding.vector }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [embeddingTask.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runtime.store.completeCurrentAttempt({
      attemptId: claimed!.command.attemptId,
      leaseToken: claimed!.command.leaseToken,
      output: { vector: [5] },
    })

    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })

    await runtime.attemptExecutor.release(claimed!)

    const parentSnapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = parentSnapshot!.childLinks[0]!.childRunId
    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId)
    expect(handlerCalls).toBe(0)
    expect(parentSnapshot?.nodes[0]?.status).toBe('waiting')
    expect(childSnapshot?.run.status).toBe('completed')
    expect(childSnapshot?.run.output).toStrictEqual({ vector: [5] })
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      },
    ])
  })

  it('does not reconcile a completed superseded task attempt', async () => {
    let handlerCalls = 0
    const embeddingTask = defineTask({
      name: 'superseded.reconciled.embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
    const workflow = defineWorkflow({
      name: 'superseded-reconciled-task-worker',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
      .task('embedding', embeddingTask)
      .build()

    const taskImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => {
        handlerCalls += 1
        return { vector: [input.text.length] }
      },
    })
    const implementation = implementWorkflow(workflow)
      .embedding(embeddingTask)
      .finish((_ctx, { embedding }) => ({ vector: embedding.vector }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const container = createTestContainer()

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [embeddingTask.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runtime.store.completeCurrentAttempt({
      attemptId: claimed!.command.attemptId,
      leaseToken: claimed!.command.leaseToken,
      output: { vector: [5] },
    })
    const parentWaiting = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = parentWaiting!.childLinks[0]!.childRunId
    const secondAttempt = await runtime.store.createAttempt({
      runId: childRunId,
      nodeName: '$task',
      input: { text: 'beta' },
    })

    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })

    await runtime.attemptExecutor.release(claimed!)

    const parentSnapshot = await runtime.store.loadRunSnapshot(run.id)
    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId)
    expect(handlerCalls).toBe(0)
    expect(parentSnapshot?.nodes[0]?.status).toBe('waiting')
    expect(childSnapshot?.nodes[0]?.status).toBe('running')
    expect(childSnapshot?.nodes[0]?.currentAttemptId).toBe(secondAttempt.id)
    expect(childSnapshot?.nodes[0]?.output).toBeUndefined()
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('starts a child workflow run and completes the parent from child output', async () => {
    const childWorkflow = defineWorkflow({
      name: 'child-content',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('write', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const parentWorkflow = defineWorkflow({
      name: 'parent-content',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .workflow('content', childWorkflow)
      .build()

    const childImplementation = implementWorkflow(childWorkflow)
      .write(async (_ctx, input) => ({ text: input.scenario }))
      .finish((_ctx, { write }) => ({ text: write.text }))
    const parentImplementation = implementWorkflow(parentWorkflow)
      .content(childWorkflow, {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
      })
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const afterStart = await runtime.store.loadRunSnapshot(parentRun.id)
    const childLink = afterStart?.childLinks[0]
    expect(afterStart?.nodes[0]?.status).toBe('waiting')
    expect(childLink?.workflowName).toBe(childWorkflow.name)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: childLink?.childRunId,
          workflowName: childWorkflow.name,
        },
      },
    ])

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: {
        kind: 'continueRun',
        runId: childLink!.childRunId,
        workflowName: childWorkflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker',
      workflowNames: [childWorkflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'activity-worker',
      claimed: claimed!,
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: {
        kind: 'continueRun',
        runId: childLink!.childRunId,
        workflowName: childWorkflow.name,
      },
    })

    expect(
      runtime
        .inspect()
        .continueRunCommands.some(
          (command) =>
            command.payload.runId === parentRun.id &&
            command.payload.workflowName === parentWorkflow.name,
        ),
    ).toBe(true)

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const finalParent = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(finalParent?.nodes[0]?.status).toBe('completed')
    expect(finalParent?.nodes[0]?.output).toStrictEqual({ text: 'alpha' })
    expect(finalParent?.run.status).toBe('completed')
    expect(finalParent?.run.output).toStrictEqual({ caseId: 'alpha' })
  })

  it('dispatches the next node after a child workflow node completes', async () => {
    const childWorkflow = defineWorkflow({
      name: 'child-before-activity',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'parent-child-before-activity',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .workflow('content', childWorkflow)
      .activity('summary', {
        input: t.object({ text: t.string() }),
        output: t.object({ caseId: t.string() }),
      })
      .build()

    const childImplementation = implementWorkflow(childWorkflow).finish(
      (_ctx, _outputs, input) => ({ text: input.scenario }),
    )
    const parentImplementation = implementWorkflow(parentWorkflow)
      .content(childWorkflow, {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
      })
      .summary(async (_ctx, input) => ({ caseId: input.text }), {
        input: (_ctx, { content }) => ({ text: content.text }),
      })
      .finish((_ctx, { summary }) => ({ caseId: summary.caseId }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const started = await runtime.store.loadRunSnapshot(parentRun.id)
    const childRunId = started!.childLinks[0]!.childRunId
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: {
        kind: 'continueRun',
        runId: childRunId,
        workflowName: childWorkflow.name,
      },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(
      snapshot?.nodes.find((node) => node.name === 'content')?.status,
    ).toBe('completed')
    expect(runtime.inspect().activityCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'activityAttempt',
          workflowName: parentWorkflow.name,
          activityName: 'summary',
          runId: parentRun.id,
          nodeName: 'summary',
          attemptId: expect.any(String),
          leaseToken: expect.any(String),
          input: { text: 'alpha' },
        },
      },
    ])
  })

  it('does not duplicate child workflow runs on repeated parent continuation', async () => {
    const childWorkflow = defineWorkflow({
      name: 'dedup-child',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'dedup-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow)
      .finish((_ctx, { child }) => ({ text: child.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(snapshot?.childLinks).toHaveLength(1)
    expect(
      runtime
        .inspect()
        .runs.filter((run) => run.workflowName === childWorkflow.name),
    ).toHaveLength(1)
  })

  it('does not remap direct child workflow input after link exists', async () => {
    const childWorkflow = defineWorkflow({
      name: 'direct-remap-child',
      input: t.unknown(),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'direct-remap-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()

    let mapCalls = 0
    const implementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow, {
        input: () => {
          mapCalls += 1
          if (mapCalls > 1) throw new Error('mapper called twice')
          return undefined
        },
      })
      .finish((_ctx, { child }) => ({ text: child.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'parent-coordinator',
      command,
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'parent-coordinator',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    const childLink = snapshot?.childLinks[0]
    expect(mapCalls).toBe(1)
    expect(snapshot?.nodes[0]).toHaveProperty('input', undefined)
    expect(snapshot?.childLinks).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: childLink?.childRunId,
          workflowName: childWorkflow.name,
        },
      },
    ])
  })

  it('re-enqueues an existing non-terminal child workflow after child enqueue fails', async () => {
    const childWorkflow = defineWorkflow({
      name: 'recover-enqueue-child',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'recover-enqueue-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow)
      .finish((_ctx, { child }) => ({ text: child.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })
    const command = {
      kind: 'continueRun' as const,
      runId: parentRun.id,
      workflowName: parentWorkflow.name,
    }
    let throwChildEnqueue = true
    const runCoordinationExecutor = {
      ...runtime.runCoordinationExecutor,
      enqueue: async (queuedCommand) => {
        if (
          throwChildEnqueue &&
          queuedCommand.workflowName === childWorkflow.name
        ) {
          throwChildEnqueue = false
          throw new Error('child enqueue down')
        }

        await runtime.runCoordinationExecutor.enqueue(queuedCommand)
      },
    } satisfies typeof runtime.runCoordinationExecutor

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [parentImplementation],
        workerId: 'parent-coordinator',
        command,
      }),
    ).rejects.toThrow('child enqueue down')

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command,
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    const childLink = snapshot?.childLinks[0]
    expect(snapshot?.childLinks).toHaveLength(1)
    expect(
      runtime
        .inspect()
        .runs.filter((run) => run.workflowName === childWorkflow.name),
    ).toHaveLength(1)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: childLink?.childRunId,
          workflowName: childWorkflow.name,
        },
      },
    ])
  })

  it('re-enqueues parent continuation after child completion wake enqueue fails', async () => {
    const childWorkflow = defineWorkflow({
      name: 'recover-wake-child',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'recover-wake-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()
    const childImplementation = implementWorkflow(childWorkflow).finish(
      (_ctx, _outputs, input) => ({ text: input.scenario }),
    )
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow)
      .finish((_ctx, { child }) => ({ text: child.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const started = await runtime.store.loadRunSnapshot(parentRun.id)
    const childRunId = started!.childLinks[0]!.childRunId
    let throwParentEnqueue = true
    const runCoordinationExecutor = {
      ...runtime.runCoordinationExecutor,
      enqueue: async (queuedCommand) => {
        if (
          throwParentEnqueue &&
          queuedCommand.workflowName === parentWorkflow.name
        ) {
          throwParentEnqueue = false
          throw new Error('parent enqueue down')
        }

        await runtime.runCoordinationExecutor.enqueue(queuedCommand)
      },
    } satisfies typeof runtime.runCoordinationExecutor
    const command = {
      kind: 'continueRun' as const,
      runId: childRunId,
      workflowName: childWorkflow.name,
    }

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container,
        workflows: [childImplementation],
        workerId: 'child-coordinator',
        command,
      }),
    ).rejects.toThrow('parent enqueue down')

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command,
    })

    expect(
      runtime
        .inspect()
        .continueRunCommands.some(
          (queuedCommand) =>
            queuedCommand.payload.runId === parentRun.id &&
            queuedCommand.payload.workflowName === parentWorkflow.name,
        ),
    ).toBe(true)
  })

  it('fails the parent node when a child workflow run fails', async () => {
    const childWorkflow = defineWorkflow({
      name: 'failed-child',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'failed-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow)
      .finish((_ctx, { child }) => ({ text: child.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const started = await runtime.store.loadRunSnapshot(parentRun.id)
    const childRunId = started!.childLinks[0]!.childRunId
    await runtime.store.failRun({
      runId: childRunId,
      error: new Error('child failed'),
    })
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.run.status).toBe('failed')
  })

  it('fails the parent node when a child workflow link points to a missing run', async () => {
    const childWorkflow = defineWorkflow({
      name: 'missing-linked-child',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const parentWorkflow = defineWorkflow({
      name: 'missing-linked-parent',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow, { input: (_ctx, _outputs, input) => input })
      .finish((_ctx, { child }) => child)

    const runtime = createInMemoryWorkflowRuntime()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { text: 'alpha' },
    })
    const staleLink = {
      identity: { runId: parentRun.id, nodeName: 'child' },
      parentRunId: parentRun.id,
      parentNodeName: 'child',
      childRunId: 'missing-child-run',
      childKind: 'workflow' as const,
      childName: childWorkflow.name,
      workflowName: childWorkflow.name,
    }
    const store = {
      ...runtime.store,
      loadNodeChildren: async (params) =>
        params.runId === parentRun.id && params.nodeName === 'child'
          ? { attempts: [], childLinks: [staleLink], mapItems: [] }
          : runtime.store.loadNodeChildren(params),
    } satisfies typeof runtime.store

    await continueWorkflowRun({
      store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe(
      'Missing child workflow run [missing-child-run]',
    )
    expect(snapshot?.run.status).toBe('failed')
  })

  it('fails the parent node when a child task link points to a missing run', async () => {
    const childTask = defineTask({
      name: 'missing-linked-task',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
    const parentWorkflow = defineWorkflow({
      name: 'missing-linked-task-parent',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .task('child', childTask)
      .build()
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childTask, { input: (_ctx, _outputs, input) => input })
      .finish((_ctx, { child }) => child)

    const runtime = createInMemoryWorkflowRuntime()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { text: 'alpha' },
    })
    const staleLink = {
      identity: { runId: parentRun.id, nodeName: 'child' },
      parentRunId: parentRun.id,
      parentNodeName: 'child',
      childRunId: 'missing-child-run',
      childKind: 'task' as const,
      childName: childTask.name,
      workflowName: childTask.name,
      taskName: childTask.name,
    }
    const store = {
      ...runtime.store,
      loadNodeChildren: async (params) =>
        params.runId === parentRun.id && params.nodeName === 'child'
          ? { attempts: [], childLinks: [staleLink], mapItems: [] }
          : runtime.store.loadNodeChildren(params),
    } satisfies typeof runtime.store

    await continueWorkflowRun({
      store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe(
      'Missing child task run [missing-child-run]',
    )
    expect(snapshot?.run.status).toBe('failed')
  })

  it('wakes and fails the parent run when a real child workflow activity fails', async () => {
    const childWorkflow = defineWorkflow({
      name: 'activity-failed-child',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('write', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const parentWorkflow = defineWorkflow({
      name: 'activity-failed-parent',
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .workflow('child', childWorkflow)
      .build()

    const childImplementation = implementWorkflow(childWorkflow)
      .write(async () => {
        throw new Error('child activity failed')
      })
      .finish((_ctx, { write }) => ({ text: write.text }))
    const parentImplementation = implementWorkflow(parentWorkflow)
      .child(childWorkflow)
      .finish((_ctx, { child }) => ({ text: child.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const parentRun = await runtime.store.createRun({
      workflowName: parentWorkflow.name,
      input: { scenario: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const started = await runtime.store.loadRunSnapshot(parentRun.id)
    const childRunId = started!.childLinks[0]!.childRunId
    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: {
        kind: 'continueRun',
        runId: childRunId,
        workflowName: childWorkflow.name,
      },
    })

    const claimed = await runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker',
      workflowNames: [childWorkflow.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runActivityAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'activity-worker',
      claimed: claimed!,
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [childImplementation],
      workerId: 'child-coordinator',
      command: {
        kind: 'continueRun',
        runId: childRunId,
        workflowName: childWorkflow.name,
      },
    })

    expect(
      runtime
        .inspect()
        .continueRunCommands.some(
          (command) =>
            command.payload.runId === parentRun.id &&
            command.payload.workflowName === parentWorkflow.name,
        ),
    ).toBe(true)

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [parentImplementation],
      workerId: 'parent-coordinator',
      command: {
        kind: 'continueRun',
        runId: parentRun.id,
        workflowName: parentWorkflow.name,
      },
    })

    const parent = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(parent?.nodes[0]?.status).toBe('failed')
    expect(parent?.run.status).toBe('failed')
  })
})
