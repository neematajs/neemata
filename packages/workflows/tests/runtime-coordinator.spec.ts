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
          normal: helpers.activity(async (_ctx, input) => ({ text: input.scenario }), {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          }),
          fallback: helpers.activity(async (_ctx, input) => ({ text: input.scenario }), {
            input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
          }),
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
    expect(activityCommands).toHaveLength(2)
    expect(activityCommands.map((item) => item.payload.attemptId)).toEqual([
      attemptId,
      attemptId,
    ])
  })

  it('preserves a started branch activity attempt when redispatch fails', async () => {
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
    ).rejects.toThrow('activity queue down')

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(snapshot?.attempts[0]?.status).toBe('started')
  })

  it('preserves a completed branch activity attempt when recovery redispatch fails', async () => {
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
    ).rejects.toThrow('activity queue down')

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
    expect(runtime.inspect().activityCommands.map((item) => item.payload.input))
      .toStrictEqual([{ scenario: 'alpha-1' }, { scenario: 'alpha-1' }])
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
    expect(afterDispatch?.attempts.map((attempt) => attempt.identity))
      .toStrictEqual([
        { runId: run.id, nodeName: 'sections', memberKey: 'summary' },
        { runId: run.id, nodeName: 'sections', memberKey: 'review' },
      ])
    expect(runtime.inspect().activityCommands.map((item) => item.payload))
      .toMatchObject([
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
    expect(afterDispatch?.attempts.map((attempt) => attempt.identity))
      .toStrictEqual([
        { runId: run.id, nodeName: 'sections', memberKey: 'summary' },
      ])
    expect(afterDispatch?.childLinks.map((link) => link.identity))
      .toStrictEqual([
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
    expect(runtime.inspect().taskCommands.map((item) => item.payload.input))
      .toStrictEqual([
        { text: 'alpha' },
        { text: 'beta' },
        { text: 'alpha' },
        { text: 'beta' },
      ])

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
        if (input.text === 'beta') throw new Error('bad embedding')
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
          error: { message: 'bad embedding' },
        },
      ],
    })
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
    expect(taskCommands).toHaveLength(2)
    expect(taskCommands.map((item) => item.payload.attemptId)).toEqual([
      attemptId,
      attemptId,
    ])
    expect(taskCommands.map((item) => item.payload.input)).toStrictEqual([
      { scenario: 'alpha-1' },
      { scenario: 'alpha-1' },
    ])
  })

  it('preserves a started branch child task attempt when redispatch fails', async () => {
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

    await expect(
      continueWorkflowRun({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: {
          ...runtime.attemptExecutor,
          dispatchTask: async () => {
            throw new Error('task queue down')
          },
        },
        container,
        workflows: [implementation],
        workerId: 'coordinator-1',
        command,
      }),
    ).rejects.toThrow('task queue down')

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    const childRunId = snapshot!.childLinks[0]!.childRunId
    const childSnapshot = await runtime.store.loadRunSnapshot(childRunId)
    expect(snapshot?.run.status).toBe('queued')
    expect(snapshot?.nodes[0]?.status).toBe('waiting')
    expect(snapshot?.attempts).toHaveLength(0)
    expect(childSnapshot?.run.status).toBe('queued')
    expect(childSnapshot?.nodes[0]?.status).toBe('running')
    expect(childSnapshot?.attempts[0]?.status).toBe('started')
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
