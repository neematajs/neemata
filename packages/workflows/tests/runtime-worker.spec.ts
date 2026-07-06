import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  type AttemptExecutor,
  type RunCoordinationExecutor,
  type WorkflowRuntimeAtomicCompletion,
  type WorkflowStore,
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runActivityWorker,
  runTaskWorker,
  runWorkflowWorker,
  runTaskAttempt,
  startTaskRun,
  WorkflowAttemptTimeoutError,
} from '../src/runtime/index.ts'
import { runWithConcurrency } from '../src/runtime/worker.ts'

describe('workflow worker runtime', () => {
  const createTestContainer = () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    return new Container({ logger })
  }

  it('starts and completes a standalone task run without parent continuation', async () => {
    const task = defineTask({
      name: 'standalone.embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => ({ id: `embedding:${input.text}` }),
    })
    const runtime = createInMemoryWorkflowRuntime()

    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      input: { text: 'alpha' },
    })

    expect(run).toMatchObject({
      kind: 'task',
      name: task.name,
      taskName: task.name,
      input: { text: 'alpha' },
    })
    expect(runtime.inspect().taskCommands[0]?.payload).toMatchObject({
      taskName: task.name,
      runId: run.id,
      nodeName: '$task',
      input: { text: 'alpha' },
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
      tasks: [implementation],
      workerId: 'task-worker-1',
      container: createTestContainer(),
      claimed: claimed!,
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ id: 'embedding:alpha' })
    expect(completed?.nodes[0]?.status).toBe('completed')
    expect(runtime.inspect().continueRunCommands).toHaveLength(0)
  })

  it('uses the atomic scoped runtime for task completion, retry, and stale reconcile writes', async () => {
    const createAtomicMarker = (
      runtime: ReturnType<typeof createInMemoryWorkflowRuntime>,
    ) => {
      const storeCalls: string[] = []
      const attemptCalls: string[] = []
      const runCalls: string[] = []
      const failOutsideWrite = (method: string): Promise<never> =>
        Promise.reject(new Error(`${method} used outside atomic completion`))
      const scopedStore = {
        ...runtime.store,
        completeCurrentAttempt: async (
          ...args: Parameters<WorkflowStore['completeCurrentAttempt']>
        ) => {
          storeCalls.push('completeCurrentAttempt')
          return runtime.store.completeCurrentAttempt(...args)
        },
        failCurrentAttempt: async (
          ...args: Parameters<WorkflowStore['failCurrentAttempt']>
        ) => {
          storeCalls.push('failCurrentAttempt')
          return runtime.store.failCurrentAttempt(...args)
        },
        timeoutCurrentAttempt: async (
          ...args: Parameters<WorkflowStore['timeoutCurrentAttempt']>
        ) => {
          storeCalls.push('timeoutCurrentAttempt')
          return runtime.store.timeoutCurrentAttempt(...args)
        },
        createAttempt: async (
          ...args: Parameters<WorkflowStore['createAttempt']>
        ) => {
          storeCalls.push('createAttempt')
          return runtime.store.createAttempt(...args)
        },
        completeNode: async (
          ...args: Parameters<WorkflowStore['completeNode']>
        ) => {
          storeCalls.push('completeNode')
          return runtime.store.completeNode(...args)
        },
        failNode: async (...args: Parameters<WorkflowStore['failNode']>) => {
          storeCalls.push('failNode')
          return runtime.store.failNode(...args)
        },
        completeRun: async (
          ...args: Parameters<WorkflowStore['completeRun']>
        ) => {
          storeCalls.push('completeRun')
          return runtime.store.completeRun(...args)
        },
        failRun: async (...args: Parameters<WorkflowStore['failRun']>) => {
          storeCalls.push('failRun')
          return runtime.store.failRun(...args)
        },
      } satisfies WorkflowStore
      const outsideStore = {
        ...runtime.store,
        completeCurrentAttempt: () =>
          failOutsideWrite('completeCurrentAttempt'),
        failCurrentAttempt: () => failOutsideWrite('failCurrentAttempt'),
        timeoutCurrentAttempt: () => failOutsideWrite('timeoutCurrentAttempt'),
        createAttempt: () => failOutsideWrite('createAttempt'),
        completeNode: () => failOutsideWrite('completeNode'),
        failNode: () => failOutsideWrite('failNode'),
        completeRun: () => failOutsideWrite('completeRun'),
        failRun: () => failOutsideWrite('failRun'),
      } satisfies WorkflowStore
      const scopedRunCoordinationExecutor = {
        ...runtime.runCoordinationExecutor,
        enqueue: async (
          ...args: Parameters<RunCoordinationExecutor['enqueue']>
        ) => {
          runCalls.push('enqueue')
          return runtime.runCoordinationExecutor.enqueue(...args)
        },
      } satisfies RunCoordinationExecutor
      const outsideRunCoordinationExecutor = {
        ...runtime.runCoordinationExecutor,
        enqueue: () => failOutsideWrite('enqueue'),
      } satisfies RunCoordinationExecutor
      const scopedAttemptExecutor = {
        ...runtime.attemptExecutor,
        dispatchTask: async (
          ...args: Parameters<AttemptExecutor['dispatchTask']>
        ) => {
          attemptCalls.push('dispatchTask')
          return runtime.attemptExecutor.dispatchTask(...args)
        },
        ack: async (...args: Parameters<AttemptExecutor['ack']>) => {
          attemptCalls.push('ack')
          return runtime.attemptExecutor.ack(...args)
        },
      } satisfies AttemptExecutor
      const outsideAttemptExecutor = {
        ...runtime.attemptExecutor,
        dispatchTask: () => failOutsideWrite('dispatchTask'),
        ack: () => failOutsideWrite('ack'),
      } satisfies AttemptExecutor
      const atomicCompletion = {
        run: async (handler) =>
          handler({
            store: scopedStore,
            runCoordinationExecutor: scopedRunCoordinationExecutor,
            attemptExecutor: scopedAttemptExecutor,
          }),
      } satisfies WorkflowRuntimeAtomicCompletion

      return {
        store: outsideStore,
        runCoordinationExecutor: outsideRunCoordinationExecutor,
        attemptExecutor: outsideAttemptExecutor,
        atomicCompletion,
        storeCalls,
        attemptCalls,
        runCalls,
      }
    }

    const container = createTestContainer()
    const completionTask = defineTask({
      name: 'atomic-marker-completion-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const completionImplementation = implementTask(completionTask, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const completionRuntime = createInMemoryWorkflowRuntime()
    const completionRun = await startTaskRun({
      ...completionRuntime,
      task: completionTask,
      input: { text: 'alpha' },
    })
    const completionClaimed = await completionRuntime.attemptExecutor.claimTask(
      {
        workerId: 'task-worker-1',
        taskNames: [completionTask.name],
        leaseMs: 30_000,
      },
    )
    expect(completionClaimed).not.toBeNull()
    const completionMarker = createAtomicMarker(completionRuntime)

    await runTaskAttempt({
      ...completionMarker,
      container,
      tasks: [completionImplementation],
      workerId: 'task-worker-1',
      claimed: completionClaimed!,
    })

    expect(completionMarker.storeCalls).toEqual([
      'completeCurrentAttempt',
      'completeNode',
      'completeRun',
    ])
    expect(completionMarker.attemptCalls).toEqual(['ack'])
    expect(completionMarker.runCalls).toEqual([])
    expect(
      (await completionRuntime.store.loadRunSnapshot(completionRun.id))?.run
        .status,
    ).toBe('completed')

    const retryTask = defineTask({
      name: 'atomic-marker-retry-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      retry: { attempts: 2 },
    })
    const retryImplementation = implementTask(retryTask, {
      handler: async () => {
        throw new Error('retry me')
      },
    })
    const retryRuntime = createInMemoryWorkflowRuntime()
    await startTaskRun({
      ...retryRuntime,
      task: retryTask,
      input: { text: 'alpha' },
    })
    const retryClaimed = await retryRuntime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [retryTask.name],
      leaseMs: 30_000,
    })
    expect(retryClaimed).not.toBeNull()
    const retryMarker = createAtomicMarker(retryRuntime)

    await runTaskAttempt({
      ...retryMarker,
      container,
      tasks: [retryImplementation],
      workerId: 'task-worker-1',
      claimed: retryClaimed!,
    })

    expect(retryMarker.storeCalls).toEqual([
      'failCurrentAttempt',
      'createAttempt',
    ])
    expect(retryMarker.attemptCalls).toEqual(['dispatchTask', 'ack'])

    const reconcileTask = defineTask({
      name: 'atomic-marker-reconcile-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const reconcileWorkflow = defineWorkflow({
      name: 'atomic-marker-reconcile-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('child', reconcileTask)
      .build()
    const reconcileWorkflowImplementation = implementWorkflow(reconcileWorkflow)
      .child(reconcileTask)
      .finish((_ctx, { child }) => ({ id: child.id }))
    const reconcileTaskImplementation = implementTask(reconcileTask, {
      handler: async () => {
        throw new Error('stale reconcile should not run handler')
      },
    })
    const reconcileRuntime = createInMemoryWorkflowRuntime()
    const parentRun = await reconcileRuntime.store.createRun({
      workflowName: reconcileWorkflow.name,
      input: { text: 'alpha' },
    })
    await reconcileRuntime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: parentRun.id,
      workflowName: reconcileWorkflow.name,
    })
    await runWorkflowWorker({
      ...reconcileRuntime,
      container,
      workflows: [reconcileWorkflowImplementation],
      workerId: 'workflow-worker-1',
    })
    const reconcileClaimed = await reconcileRuntime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [reconcileTask.name],
      leaseMs: 30_000,
    })
    expect(reconcileClaimed).not.toBeNull()
    await reconcileRuntime.store.completeCurrentAttempt({
      attemptId: reconcileClaimed!.command.attemptId,
      leaseToken: reconcileClaimed!.command.leaseToken,
      output: { id: 'alpha' },
    })
    const reconcileMarker = createAtomicMarker(reconcileRuntime)

    await runTaskAttempt({
      ...reconcileMarker,
      container,
      tasks: [reconcileTaskImplementation],
      workerId: 'task-worker-1',
      claimed: reconcileClaimed!,
    })

    expect(reconcileMarker.storeCalls).toEqual(['completeNode', 'completeRun'])
    expect(reconcileMarker.attemptCalls).toEqual(['ack'])
    expect(reconcileMarker.runCalls).toEqual(['enqueue'])
    expect(
      (await reconcileRuntime.store.loadRunSnapshot(parentRun.id))?.run.status,
    ).toBe('waiting')
  })

  it('reconciles stale timed-out attempts like failed attempts', async () => {
    const task = defineTask({
      name: 'worker.reconcile-timeout-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const workflow = defineWorkflow({
      name: 'worker.reconcile-timeout-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
      .task('child', task)
      .build()
    const workflowImplementation = implementWorkflow(workflow)
      .child(task)
      .finish((_ctx, { child }) => ({ id: child.id }))
    const taskImplementation = implementTask(task, {
      handler: async () => {
        throw new Error('stale timed-out attempt should not run handler')
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })
    await runWorkflowWorker({
      ...runtime,
      container,
      workflows: [workflowImplementation],
      workerId: 'workflow-worker-1',
    })
    const claimed = await runtime.attemptExecutor.claimTask({
      workerId: 'task-worker-1',
      taskNames: [task.name],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()
    await runtime.store.timeoutCurrentAttempt({
      attemptId: claimed!.command.attemptId,
      leaseToken: claimed!.command.leaseToken,
      error: new Error('deadline exceeded'),
    })

    const result = await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      tasks: [taskImplementation],
      workerId: 'task-worker-1',
      claimed: claimed!,
    })

    const childSnapshot = await runtime.store.loadRunSnapshot(
      claimed!.command.runId,
    )
    expect(result.status).toBe('processed')
    expect(childSnapshot?.run.status).toBe('failed')
    expect(childSnapshot?.nodes[0]?.status).toBe('failed')
    expect(childSnapshot?.nodes[0]?.error?.message).toBe('deadline exceeded')
    expect(runtime.inspect().continueRunCommands).toHaveLength(1)
    expect(runtime.inspect().taskCommands).toStrictEqual([])
  })

  it('runs workflow worker loop by claiming continue commands', async () => {
    const workflow = defineWorkflow({
      name: 'worker.empty-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ text: input.text }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    const result = await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(result.processed).toBe(1)
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ text: 'alpha' })
    expect(runtime.inspect().continueRunCommands).toStrictEqual([])
  })

  it('runs opt-in retention pruning during idle workflow worker cycles', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: 'worker-retention-workflow',
      input: {},
    })
    await runtime.store.completeRun({ runId: run.id, output: { ok: true } })
    await new Promise((resolve) => setTimeout(resolve, 5))

    const result = await runWorkflowWorker({
      ...runtime,
      container: createTestContainer(),
      workflows: [],
      workerId: 'retention-worker-1',
      maxIdleClaims: 1,
      retention: {
        olderThan: '0ms',
        batchSize: 10,
      },
    })

    expect(result.processed).toBe(0)
    await expect(runtime.store.loadRunSnapshot(run.id)).resolves.toBeUndefined()
  })

  it('releases continuation commands when attempt dispatch fails', async () => {
    const workflow = defineWorkflow({
      name: 'worker.dispatch-failure-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.text }))
      .finish((_ctx, { content }) => content)
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    await expect(
      runWorkflowWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchActivity: async () => {
            throw new Error('activity queue down')
          },
        },
        container: createTestContainer(),
        workflows: [implementation],
        workerId: 'workflow-worker-1',
      }),
    ).rejects.toThrow('activity queue down')

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('running')
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.attempts[0]?.status).toBe('started')
    expect(runtime.inspect().continueRunCommands).toHaveLength(1)
  })

  it('can poll after an idle claim without hot-looping', async () => {
    const workflow = defineWorkflow({
      name: 'worker.polling-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ text: input.text }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    let claims = 0

    const result = await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: {
        ...runtime.runCoordinationExecutor,
        async claim(params) {
          claims += 1
          if (claims === 1) {
            await runtime.runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId: run.id,
              workflowName: workflow.name,
            })
            return null
          }

          return runtime.runCoordinationExecutor.claim(params)
        },
      },
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'workflow-worker-1',
      maxIdleClaims: 2,
      idleDelayMs: 1,
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(result.processed).toBe(1)
    expect(completed?.run.status).toBe('completed')
  })

  it('releases continue commands when the run lease is busy', async () => {
    const workflow = defineWorkflow({
      name: 'worker.busy-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ text: input.text }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    const lease = await runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 30_000,
    })
    expect(lease).toBeDefined()
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    const busy = await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })

    expect(busy.processed).toBe(0)
    expect(runtime.inspect().continueRunCommands).toHaveLength(1)

    await runtime.store.releaseRunLease(lease!)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const completed = await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })
    expect(completed.processed).toBe(1)
    expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
      'completed',
    )
  })

  it('releases ignored continue commands instead of acking them', async () => {
    const workflow = defineWorkflow({
      name: 'worker.ignored-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ text: input.text }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: 'missing-run',
      workflowName: workflow.name,
    })
    const store = {
      ...runtime.store,
      acquireRunLease: async () => ({
        runId: 'missing-run',
        leaseToken: 'missing-run-lease',
        version: 1,
      }),
      renewRunLease: async () => ({
        runId: 'missing-run',
        leaseToken: 'missing-run-lease',
        version: 1,
      }),
      releaseRunLease: async () => {},
    }

    const result = await runWorkflowWorker({
      store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })

    expect(result.processed).toBe(0)
    expect(runtime.inspect().continueRunCommands).toHaveLength(1)
  })

  it('runs activity worker loop by claiming activity attempts', async () => {
    const workflow = defineWorkflow({
      name: 'worker.activity-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: `content:${input.text}` }))
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })
    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })

    const result = await runActivityWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
    })

    expect(result.processed).toBe(1)
    expect(runtime.inspect().activityCommands).toStrictEqual([])
    expect(runtime.inspect().continueRunCommands).toHaveLength(1)

    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })
    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ text: 'content:alpha' })
  })

  it('coalesces continue commands produced by parallel activity fan-out', async () => {
    const workflow = defineWorkflow({
      name: 'worker.parallel-coalesced-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .parallel('sections', (helpers) => ({
        alpha: helpers.activity({
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        beta: helpers.activity({
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
        }),
        gamma: helpers.activity({
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
        }),
      }))
      .build()
    const implementation = implementWorkflow(workflow)
      .sections(({ activity }) => ({
        alpha: activity(async (_ctx, input) => ({ text: `a:${input.text}` }), {
          input: (_ctx, _outputs, input) => input,
        }),
        beta: activity(async (_ctx, input) => ({ text: `b:${input.text}` }), {
          input: (_ctx, _outputs, input) => input,
        }),
        gamma: activity(async (_ctx, input) => ({ text: `c:${input.text}` }), {
          input: (_ctx, _outputs, input) => input,
        }),
      }))
      .finish((_ctx, { sections }) => ({
        text: [
          sections.alpha.text,
          sections.beta.text,
          sections.gamma.text,
        ].join('|'),
      }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })
    await runActivityWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      maxIdleClaims: 4,
    })

    expect(runtime.inspect().continueRunCommands).toHaveLength(1)

    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-2',
    })
    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({
      text: 'a:alpha|b:alpha|c:alpha',
    })
  })

  it('retries a failed direct activity attempt before failing the run', async () => {
    const workflow = defineWorkflow({
      name: 'worker.retry-activity-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
        retry: { attempts: 2 },
      })
      .build()
    let calls = 0
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => {
        calls += 1
        if (calls === 1) throw new Error('transient activity failure')
        return { text: `content:${input.text}` }
      })
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })
    await runActivityWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
      maxIdleClaims: 2,
    })
    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(calls).toBe(2)
    expect(completed?.attempts).toHaveLength(2)
    expect(completed?.attempts.map((attempt) => attempt.status)).toStrictEqual([
      'failed',
      'completed',
    ])
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ text: 'content:alpha' })
  })

  it('records timed-out activity attempts and delivers a timeout signal', async () => {
    const workflow = defineWorkflow({
      name: 'worker.timeout-activity-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
        timeout: '5ms',
      })
      .build()
    let releaseLateHandler!: () => void
    const lateHandlerFinished = new Promise<void>((resolve) => {
      releaseLateHandler = resolve
    })
    let timeoutReason: unknown
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input, lifecycle) => {
        lifecycle?.signal.addEventListener(
          'abort',
          () => {
            timeoutReason = lifecycle.signal.reason
          },
          { once: true },
        )
        await lateHandlerFinished
        return { text: `too-late:${input.text}` }
      })
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })
    await runActivityWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'activity-worker-1',
    })
    releaseLateHandler()
    await lateHandlerFinished
    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })

    const failed = await runtime.store.loadRunSnapshot(run.id)
    expect(timeoutReason).toStrictEqual({ type: 'timeout' })
    expect(failed?.attempts[0]?.status).toBe('timedOut')
    expect(failed?.attempts[0]?.error).toMatchObject({
      name: 'WorkflowAttemptTimeoutError',
      message: expect.stringContaining('timed out after 5ms'),
    })
    expect(failed?.nodes[0]?.status).toBe('failed')
    expect(failed?.nodes[0]?.output).toBeUndefined()
    expect(failed?.run.status).toBe('failed')
  })

  it('does not hot-loop when a claimed activity is not routeable', async () => {
    const workflow = defineWorkflow({
      name: 'worker.route-miss-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .activity('content', {
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.text }))
      .finish((_ctx, { content }) => ({ text: content.text }))
    const runtime = createInMemoryWorkflowRuntime()
    const container = createTestContainer()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })
    await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      workerId: 'workflow-worker-1',
    })

    const command = runtime.inspect().activityCommands[0]!
    ;(command.payload as { activityName: string }).activityName = 'missing'
    let claimCount = 0
    let releaseCount = 0
    const attemptExecutor: AttemptExecutor = {
      ...runtime.attemptExecutor,
      claimActivity: async (worker) => {
        const claimed = await runtime.attemptExecutor.claimActivity(worker)
        if (!claimed) return null
        claimCount += 1
        if (claimCount > 1) throw new Error('claimed released activity again')
        return claimed
      },
      release: async (attempt) => {
        releaseCount += 1
        await runtime.attemptExecutor.release(attempt)
      },
    }

    const result = await runActivityWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor,
      container,
      workflows: [implementation],
      activityNames: ['missing'],
      workerId: 'activity-worker-1',
      maxIdleClaims: 2,
    })

    expect(result.processed).toBe(0)
    expect(claimCount).toBe(1)
    expect(releaseCount).toBe(1)
  })

  it('waits for active worker lanes when one run fails', async () => {
    const workflow = defineWorkflow({
      name: 'worker.reject-workflow',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    }).build()
    let slowFinished = false
    const implementation = implementWorkflow(workflow).finish(
      async (_ctx, _outputs, input) => {
        if (input.text === 'bad') throw new Error('bad finish')
        await new Promise((resolve) => setTimeout(resolve, 10))
        slowFinished = true
        return { text: input.text }
      },
    )
    const runtime = createInMemoryWorkflowRuntime()
    const badRun = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'bad' },
    })
    const slowRun = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { text: 'slow' },
    })
    for (const run of [badRun, slowRun]) {
      await runtime.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      })
    }

    const result = await runWorkflowWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      workflows: [implementation],
      workerId: 'workflow-worker-1',
      concurrency: 2,
    })

    const badSnapshot = await runtime.store.loadRunSnapshot(badRun.id)
    const slowSnapshot = await runtime.store.loadRunSnapshot(slowRun.id)
    expect(result.processed).toBe(2)
    expect(badSnapshot?.run.status).toBe('failed')
    expect(slowSnapshot?.run.status).toBe('completed')
    expect(slowFinished).toBe(true)
  })

  it('runs task worker loop by claiming task attempts', async () => {
    const task = defineTask({
      name: 'worker.loop-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => ({ id: `embedding:${input.text}` }),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      input: { text: 'alpha' },
    })

    const result = await runTaskWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      tasks: [implementation],
      workerId: 'task-worker-1',
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(result.processed).toBe(1)
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ id: 'embedding:alpha' })
    expect(runtime.inspect().taskCommands).toStrictEqual([])
  })

  it('retries a failed standalone task attempt before failing the run', async () => {
    const task = defineTask({
      name: 'worker.retry-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      retry: { attempts: 2 },
    })
    let calls = 0
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => {
        calls += 1
        if (calls === 1) throw new Error('transient task failure')
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      input: { text: 'alpha' },
    })

    const result = await runTaskWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      tasks: [implementation],
      workerId: 'task-worker-1',
      maxIdleClaims: 2,
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(result.processed).toBe(2)
    expect(calls).toBe(2)
    expect(completed?.attempts).toHaveLength(2)
    expect(completed?.attempts.map((attempt) => attempt.status)).toStrictEqual([
      'failed',
      'completed',
    ])
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ id: 'embedding:alpha' })
  })

  it('retries timed-out task attempts and ignores the late handler completion', async () => {
    const task = defineTask({
      name: 'worker.timeout-retry-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      retry: { attempts: 2 },
      timeout: '5ms',
    })
    let calls = 0
    let releaseLateHandler!: () => void
    const lateHandlerFinished = new Promise<void>((resolve) => {
      releaseLateHandler = resolve
    })
    let timeoutReason: unknown
    const implementation = implementTask(task, {
      handler: async (_ctx, input, lifecycle) => {
        calls += 1
        if (calls === 1) {
          lifecycle?.signal.addEventListener(
            'abort',
            () => {
              timeoutReason = lifecycle.signal.reason
            },
            { once: true },
          )
          await lateHandlerFinished
          return { id: 'too-late' }
        }
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      input: { text: 'alpha' },
    })

    await runTaskWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      tasks: [implementation],
      workerId: 'task-worker-1',
      maxIdleClaims: 2,
    })
    releaseLateHandler()
    await lateHandlerFinished

    const completed = await runtime.store.loadRunSnapshot(run.id)
    const exportedError = new WorkflowAttemptTimeoutError({
      runId: run.id,
      nodeName: '$task',
      attemptId: completed!.attempts[0]!.id,
      timeoutMs: 5,
    })
    expect(exportedError.timeoutMs).toBe(5)
    expect(calls).toBe(2)
    expect(timeoutReason).toStrictEqual({ type: 'timeout' })
    expect(completed?.attempts.map((attempt) => attempt.status)).toStrictEqual([
      'timedOut',
      'completed',
    ])
    expect(completed?.attempts[0]?.error).toMatchObject({
      name: 'WorkflowAttemptTimeoutError',
      message: expect.stringContaining('timed out after 5ms'),
    })
    expect(completed?.run.status).toBe('completed')
    expect(completed?.run.output).toStrictEqual({ id: 'embedding:alpha' })
  })

  it('does not time out task attempts without a declared timeout', async () => {
    const task = defineTask({
      name: 'worker.no-timeout-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    const run = await startTaskRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      task,
      input: { text: 'alpha' },
    })

    await runTaskWorker({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container: createTestContainer(),
      tasks: [implementation],
      workerId: 'task-worker-1',
    })

    const completed = await runtime.store.loadRunSnapshot(run.id)
    expect(completed?.attempts).toHaveLength(1)
    expect(completed?.attempts[0]?.status).toBe('completed')
    expect(completed?.run.status).toBe('completed')
  })

  it('keeps exponential retry runAt values aligned with attempt numbers', async () => {
    vi.useFakeTimers()
    try {
      const base = new Date('2026-01-01T00:00:00.000Z')
      vi.setSystemTime(base)
      const task = defineTask({
        name: 'worker.retry-backoff-task',
        input: t.object({ text: t.string() }),
        output: t.object({ id: t.string() }),
        retry: { attempts: 3, delay: '1s', backoff: 'exponential' },
      })
      const implementation = implementTask(task, {
        handler: async () => {
          throw new Error('still failing')
        },
      })
      const runtime = createInMemoryWorkflowRuntime()
      const run = await startTaskRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        task,
        input: { text: 'alpha' },
      })

      await runTaskWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        tasks: [implementation],
        workerId: 'task-worker-1',
      })
      expect(runtime.inspect().taskCommands[0]?.runAt?.toISOString()).toBe(
        '2026-01-01T00:00:01.000Z',
      )

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
      await runTaskWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        tasks: [implementation],
        workerId: 'task-worker-1',
      })
      expect(runtime.inspect().taskCommands[0]?.runAt?.toISOString()).toBe(
        '2026-01-01T00:00:03.000Z',
      )

      vi.setSystemTime(new Date('2026-01-01T00:00:03.000Z'))
      await runTaskWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        container: createTestContainer(),
        tasks: [implementation],
        workerId: 'task-worker-1',
      })

      const failed = await runtime.store.loadRunSnapshot(run.id)
      expect(runtime.inspect().taskCommands).toStrictEqual([])
      expect(failed?.attempts.map((attempt) => attempt.status)).toStrictEqual([
        'failed',
        'failed',
        'failed',
      ])
      expect(failed?.run.status).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('heartbeats task attempts while the handler is running', async () => {
    vi.useFakeTimers()
    const task = defineTask({
      name: 'worker.heartbeat-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => {
        await new Promise((resolve) => setTimeout(resolve, 45))
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    try {
      const run = await startTaskRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        task,
        input: { text: 'alpha' },
      })
      let heartbeatCount = 0

      const worker = runTaskWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          heartbeat: async (attempt) => {
            heartbeatCount += 1
            return await runtime.attemptExecutor.heartbeat(attempt)
          },
        },
        container: createTestContainer(),
        tasks: [implementation],
        workerId: 'task-worker-1',
        leaseMs: 10,
      })
      await vi.advanceTimersByTimeAsync(45)
      await worker

      const afterRunHeartbeatCount = heartbeatCount
      await vi.advanceTimersByTimeAsync(20)

      expect((await runtime.store.loadRunSnapshot(run.id))?.run.status).toBe(
        'completed',
      )
      expect(afterRunHeartbeatCount).toBeGreaterThan(0)
      expect(heartbeatCount).toBe(afterRunHeartbeatCount)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons task completion when heartbeat reports lease loss', async () => {
    vi.useFakeTimers()
    const task = defineTask({
      name: 'worker.heartbeat-lost-embedding',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    let leaseLostReason: unknown
    const implementation = implementTask(task, {
      handler: async (_ctx, input, lifecycle) => {
        lifecycle?.signal.addEventListener(
          'abort',
          () => {
            leaseLostReason = lifecycle.signal.reason
          },
          { once: true },
        )
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    try {
      const run = await startTaskRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        task,
        input: { text: 'alpha' },
      })
      let acked = false
      let released = false

      const worker = runTaskWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          heartbeat: async () => {
            throw new Error('Workflow attempt heartbeat lease lost')
          },
          ack: async (attempt) => {
            acked = true
            await runtime.attemptExecutor.ack(attempt)
          },
          release: async (attempt) => {
            released = true
            await runtime.attemptExecutor.release(attempt)
          },
        },
        container: createTestContainer(),
        tasks: [implementation],
        workerId: 'task-worker-1',
        leaseMs: 3,
      })
      await vi.advanceTimersByTimeAsync(1)
      const result = await worker
      await vi.advanceTimersByTimeAsync(30)
      expect(result.processed).toBe(0)

      const snapshot = await runtime.store.loadRunSnapshot(run.id)
      expect(snapshot?.run.status).toBe('running')
      expect(snapshot?.attempts[0]?.status).toBe('started')
      expect(runtime.inspect().taskCommands).toHaveLength(1)
      expect(leaseLostReason).toStrictEqual({ type: 'leaseLost' })
      expect(acked).toBe(false)
      expect(released).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ack-drops task attempts when heartbeat observes cancellation', async () => {
    vi.useFakeTimers()
    const task = defineTask({
      name: 'worker.cancel-observed-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      retry: { attempts: 2 },
    })
    let cancelReason: unknown
    const implementation = implementTask(task, {
      handler: async (_ctx, input, lifecycle) => {
        lifecycle?.signal.addEventListener(
          'abort',
          () => {
            cancelReason = lifecycle.signal.reason
          },
          { once: true },
        )
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    try {
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(task, { text: 'alpha' })
      await client.cancel(run.id)
      let acked = false
      let released = false
      let retried = false

      const worker = runTaskWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          ack: async (attempt) => {
            acked = true
            await runtime.attemptExecutor.ack(attempt)
          },
          release: async (attempt) => {
            released = true
            await runtime.attemptExecutor.release(attempt)
          },
          dispatchTask: async (...args) => {
            retried = true
            await runtime.attemptExecutor.dispatchTask(...args)
          },
        },
        container: createTestContainer(),
        tasks: [implementation],
        workerId: 'task-worker-1',
        leaseMs: 3,
      })
      await vi.advanceTimersByTimeAsync(30)
      const result = await worker

      const snapshot = await runtime.store.loadRunSnapshot(run.id)
      expect(result.processed).toBe(1)
      expect(cancelReason).toStrictEqual({ type: 'cancelled' })
      expect(snapshot?.run.status).toBe('cancelling')
      expect(snapshot?.attempts[0]?.status).toBe('started')
      expect(snapshot?.attempts[0]?.output).toBeUndefined()
      expect(runtime.inspect().taskCommands).toStrictEqual([])
      expect(acked).toBe(true)
      expect(released).toBe(false)
      expect(retried).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('releases task attempts when the worker shutdown signal aborts', async () => {
    vi.useFakeTimers()
    const task = defineTask({
      name: 'worker.shutdown-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    let shutdownReason: unknown
    let handlerStarted!: () => void
    const handlerStartedPromise = new Promise<void>((resolve) => {
      handlerStarted = resolve
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input, lifecycle) => {
        handlerStarted()
        lifecycle?.signal.addEventListener(
          'abort',
          () => {
            shutdownReason = lifecycle.signal.reason
          },
          { once: true },
        )
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { id: `embedding:${input.text}` }
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    try {
      const run = await startTaskRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
        task,
        input: { text: 'alpha' },
      })
      const shutdown = new AbortController()
      let acked = false
      let released = false

      const worker = runTaskWorker({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          ack: async (attempt) => {
            acked = true
            await runtime.attemptExecutor.ack(attempt)
          },
          release: async (attempt) => {
            released = true
            await runtime.attemptExecutor.release(attempt)
          },
        },
        container: createTestContainer(),
        tasks: [implementation],
        workerId: 'task-worker-1',
        leaseMs: 3,
        signal: shutdown.signal,
      })
      await handlerStartedPromise
      shutdown.abort()
      await vi.advanceTimersByTimeAsync(30)
      const result = await worker

      const snapshot = await runtime.store.loadRunSnapshot(run.id)
      expect(result.processed).toBe(0)
      expect(shutdownReason).toStrictEqual({ type: 'shutdown' })
      expect(snapshot?.run.status).toBe('running')
      expect(snapshot?.attempts[0]?.status).toBe('started')
      expect(runtime.inspect().taskCommands).toHaveLength(1)
      expect(acked).toBe(false)
      expect(released).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs workers without exceeding concurrency', async () => {
    const items = [1, 2, 3, 4, 5]
    let active = 0
    let maxActive = 0

    await runWithConcurrency(items, 2, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
    })

    expect(maxActive).toBe(2)
  })

  it('rejects invalid concurrency', async () => {
    await expect(runWithConcurrency([1], 0, async () => {})).rejects.toThrow(
      'Concurrency must be a positive integer',
    )
  })
})
