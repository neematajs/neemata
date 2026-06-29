import {
  Container,
  createLogger,
  createValueInjectable,
} from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  continueWorkflowRun,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
  runActivityAttempt,
  runTaskAttempt,
} from '../src/index.ts'
import { createInMemoryWorkflowRuntime } from './support/in-memory-runtime.ts'

describe('workflow runtime coordinator', () => {
  const createTestContainer = () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    return new Container({ logger })
  }

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

  it('fails the attempt, node, and run when dispatching the activity fails', async () => {
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

    await continueWorkflowRun({
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
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('failed')
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.attempts[0]?.status).toBe('failed')
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

  it('dispatches a task attempt, runs it, and completes run after continuation', async () => {
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

    const afterDispatch = runtime.inspect()
    expect(afterDispatch.taskCommands).toHaveLength(1)
    expect(afterDispatch.taskCommands[0]?.payload).toMatchObject({
      kind: 'taskAttempt',
      taskName: 'embedding.generate',
      workflowName: workflow.name,
      runId: run.id,
      nodeName: 'embedding',
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

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(handlerCalls).toBe(0)
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.attempts[0]?.status).toBe('started')
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

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(taskCommand.taskName).toBe(embeddingTask.name)
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.attempts[0]?.status).toBe('started')
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

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(handlerCalls).toBe(0)
    expect(snapshot?.nodes[0]?.status).toBe('completed')
    expect(snapshot?.nodes[0]?.output).toStrictEqual({ vector: [5] })
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
    const secondAttempt = await runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'embedding',
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

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(handlerCalls).toBe(0)
    expect(snapshot?.nodes[0]?.status).toBe('running')
    expect(snapshot?.nodes[0]?.currentAttemptId).toBe(secondAttempt.id)
    expect(snapshot?.nodes[0]?.output).toBeUndefined()
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
    expect(snapshot?.nodes.find((node) => node.name === 'content')?.status).toBe(
      'completed',
    )
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
    expect(snapshot?.run.status).toBe('queued')

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

    const failedRun = await runtime.store.loadRunSnapshot(parentRun.id)
    expect(failedRun?.run.status).toBe('failed')
  })
})
