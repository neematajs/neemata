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
import { createInMemoryWorkflowRuntime } from '../src/testing/index.ts'

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

  it('fails and acks current activity attempts with missing workflow implementations', async () => {
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

    await runtime.attemptExecutor.release(claimed!)

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.attempts[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.nodes[0]?.error?.message).toBe(
      'No workflow implementation registered for [missing-workflow]',
    )
    expect(runtime.inspect().activityCommands).toHaveLength(0)
    expect(runtime.inspect().continueRunCommands).toStrictEqual([
      {
        id: expect.any(String),
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: 'missing-workflow',
        },
      },
    ])
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
      workflows: [implementation],
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
      workflows: [implementation],
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

  it('fails a task attempt whose command task does not match the workflow node target', async () => {
    let embeddingHandlerCalls = 0
    let poisonHandlerCalls = 0
    const embeddingTask = defineTask({
      name: 'validated.embedding.generate',
      input: t.object({ text: t.string() }),
      output: t.object({ vector: t.array(t.number()) }),
    })
    const poisonTask = defineTask({
      name: 'validated.embedding.poison',
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

    const embeddingImplementation = implementTask(embeddingTask, {
      handler: async (_ctx, input) => {
        embeddingHandlerCalls += 1
        return { vector: [input.text.length] }
      },
    })
    const poisonImplementation = implementTask(poisonTask, {
      handler: async (_ctx, input) => {
        poisonHandlerCalls += 1
        return { vector: [input.text.length + 1] }
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

    const taskCommand = claimed!.command
    if (taskCommand.kind !== 'taskAttempt') {
      throw new Error(`Unexpected command kind [${taskCommand.kind}]`)
    }

    await runTaskAttempt({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      container,
      workflows: [implementation],
      tasks: [embeddingImplementation, poisonImplementation],
      workerId: 'task-worker-1',
      claimed: {
        ...claimed!,
        command: {
          ...taskCommand,
          taskName: poisonTask.name,
        },
      },
    })

    await runtime.attemptExecutor.release(claimed!)

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(embeddingHandlerCalls).toBe(0)
    expect(poisonHandlerCalls).toBe(0)
    expect(snapshot?.nodes[0]?.status).toBe('failed')
    expect(snapshot?.attempts[0]?.status).toBe('failed')
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
      workflows: [implementation],
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
      workflows: [implementation],
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
})
