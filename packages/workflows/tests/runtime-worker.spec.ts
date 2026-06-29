import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  runActivityWorker,
  runTaskWorker,
  runWorkflowWorker,
  runTaskAttempt,
  runWithConcurrency,
  startTaskRun,
} from '../src/index.ts'
import { createInMemoryWorkflowRuntime } from './support/in-memory-runtime.ts'

describe('workflow worker concurrency', () => {
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
    await expect(
      runWithConcurrency([1], 0, async () => {}),
    ).rejects.toThrow('Concurrency must be a positive integer')
  })
})
