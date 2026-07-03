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
  createInMemoryWorkflowRuntime,
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
    expect(snapshot?.run.status).toBe('queued')
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

  it('fails timed-out activity attempts through the existing failure path', async () => {
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
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => {
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
    expect(failed?.attempts[0]?.status).toBe('failed')
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
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => {
        calls += 1
        if (calls === 1) {
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
    expect(completed?.attempts.map((attempt) => attempt.status)).toStrictEqual([
      'failed',
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
            await runtime.attemptExecutor.heartbeat(attempt)
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
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => {
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
      expect(snapshot?.run.status).toBe('queued')
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
