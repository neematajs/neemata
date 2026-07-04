import { Container, createLogger, createValueInjectable } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
} from '../src/runtime/index.ts'

describe('workflow runtime client', () => {
  const createTestContainer = () => {
    const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
    return new Container({ logger })
  }

  it('starts workflows and reads their snapshots', async () => {
    const prefix = createValueInjectable('wf')
    const workflow = defineWorkflow({
      name: 'client-started-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow, {
      dependencies: { prefix },
      tags: (ctx, input) => ({
        prefix: ctx.prefix,
        scenario: input.scenario,
      }),
      idempotency: (ctx, input) => [ctx.prefix, input.scenario],
    }).finish((_ctx, _outputs, input) => ({ caseId: input.scenario }))
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      container: createTestContainer(),
      workflows: [implementation],
    })

    const run = await client.start(workflow, { scenario: 'alpha' })
    const snapshot = await client.get(run.id)

    expect(run).toMatchObject({
      kind: 'workflow',
      name: workflow.name,
      workflowName: workflow.name,
      tags: { prefix: 'wf', scenario: 'alpha' },
      idempotencyKey: ['wf', 'alpha'],
    })
    expect(snapshot?.run.id).toBe(run.id)
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

  it('starts workflows at a delayed time while exposing the run immediately', async () => {
    const workflow = defineWorkflow({
      name: 'client-delayed-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const startAt = new Date(Date.now() + 60_000)

    const run = await client.start(workflow, { scenario: 'alpha' }, { startAt })

    await expect(client.get(run.id)).resolves.toMatchObject({
      run: { id: run.id, status: 'queued' },
    })
    expect(runtime.inspect().continueRunCommands).toMatchObject([
      {
        runAt: startAt,
        payload: {
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        },
      },
    ])
  })

  it('rejects invalid workflow start input before creating a run', async () => {
    const workflow = defineWorkflow({
      name: 'client-invalid-workflow-input',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    await expect(
      client.start(workflow, { scenario: 123 } as never),
    ).rejects.toThrow('Invalid workflow input [client-invalid-workflow-input]')

    await expect(client.list()).resolves.toStrictEqual({ runs: [] })
    expect(runtime.inspect().continueRunCommands).toStrictEqual([])
  })

  it('starts tasks and dispatches the task attempt', async () => {
    const prefix = createValueInjectable('task')
    const task = defineTask({
      name: 'client-started-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const implementation = implementTask(task, {
      dependencies: { prefix },
      idempotency: (ctx, input) => [ctx.prefix, input.text],
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      container: createTestContainer(),
      tasks: [implementation],
    })

    const run = await client.start(task, { text: 'alpha' })

    expect(run).toMatchObject({
      kind: 'task',
      name: task.name,
      workflowName: task.name,
      taskName: task.name,
      input: { text: 'alpha' },
      idempotencyKey: ['task', 'alpha'],
    })
    expect(runtime.inspect().taskCommands).toMatchObject([
      {
        payload: {
          kind: 'taskAttempt',
          runId: run.id,
          taskName: task.name,
          input: { text: 'alpha' },
          idempotencyKey: ['task', 'alpha'],
        },
      },
    ])
  })

  it('starts tasks at a delayed time while exposing the run immediately', async () => {
    const task = defineTask({
      name: 'client-delayed-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const startAt = new Date(Date.now() + 60_000)

    const run = await client.start(task, { text: 'alpha' }, { startAt })

    await expect(client.get(run.id)).resolves.toMatchObject({
      run: { id: run.id, status: 'queued' },
    })
    expect(runtime.inspect().taskCommands).toMatchObject([
      {
        runAt: startAt,
        payload: {
          kind: 'taskAttempt',
          runId: run.id,
          taskName: task.name,
          input: { text: 'alpha' },
        },
      },
    ])
  })

  it('rejects invalid task start input before creating a run', async () => {
    const task = defineTask({
      name: 'client-invalid-task-input',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    await expect(client.start(task, { text: 123 } as never)).rejects.toThrow(
      'Invalid task input [client-invalid-task-input]',
    )

    await expect(client.list()).resolves.toStrictEqual({ runs: [] })
    expect(runtime.inspect().taskCommands).toStrictEqual([])
  })

  it('lists runs through the store-backed client', async () => {
    const workflow = defineWorkflow({
      name: 'client-listed-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    const alpha = await client.start(
      workflow,
      { scenario: 'alpha' },
      {
        tags: { tenantId: 'tenant-1' },
      },
    )
    await client.start(
      workflow,
      { scenario: 'beta' },
      {
        tags: { tenantId: 'tenant-2' },
      },
    )

    await expect(
      client.list({
        name: workflow.name,
        tags: { tenantId: 'tenant-1' },
        input: { scenario: 'alpha' },
      }),
    ).resolves.toMatchObject({
      runs: [{ id: alpha.id }],
    })
  })

  it('manages schedules through the adapter scheduler', async () => {
    const workflow = defineWorkflow({
      name: 'client-scheduled-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const schedule = defineSchedule({
      name: 'client-schedule',
      runnable: workflow,
      input: { scenario: 'alpha' },
      every: '1m',
      tags: { tenantId: 'tenant-1' },
      immediately: true,
    })

    await runtime.scheduler.reconcile([schedule])
    await expect(client.schedules.list()).resolves.toMatchObject([
      {
        name: 'client-schedule',
        runnableKind: 'workflow',
        runnableName: workflow.name,
        input: { scenario: 'alpha' },
        tags: { tenantId: 'tenant-1' },
        everyMs: 60_000,
        enabled: true,
      },
    ])

    const first = await client.schedules.trigger('client-schedule')
    const second = await client.schedules.trigger('client-schedule')

    expect(first.tags).toStrictEqual({
      tenantId: 'tenant-1',
      schedule: 'client-schedule',
    })
    expect(second.id).not.toBe(first.id)
    await client.schedules.setEnabled('client-schedule', false)
    await expect(client.schedules.list()).resolves.toMatchObject([
      { name: 'client-schedule', enabled: false },
    ])
  })

  it('throws clearly when schedule APIs are used without scheduler support', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
    })

    await expect(client.schedules.list()).rejects.toThrow(
      'Workflow runtime adapter does not support schedules',
    )
  })

  it('requests cancellation and enqueues a continuation', async () => {
    const workflow = defineWorkflow({
      name: 'client-cancelled-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { scenario: 'alpha' })

    const cancelling = await client.cancel(run.id)
    const cancellingAgain = await client.cancel(run.id)

    expect(cancelling?.status).toBe('cancelling')
    expect(cancellingAgain?.status).toBe('cancelling')
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

  it('returns terminal runs unchanged when cancellation is requested', async () => {
    const workflow = defineWorkflow({
      name: 'client-terminal-cancel-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { scenario: 'alpha' })
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'done' },
    })

    const completed = await client.cancel(run.id)

    expect(completed?.status).toBe('completed')
    expect(completed?.output).toStrictEqual({ caseId: 'done' })
  })
})
