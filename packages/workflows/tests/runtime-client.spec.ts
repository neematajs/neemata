import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

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
  it('starts workflows and reads their snapshots', async () => {
    const workflow = defineWorkflow({
      name: 'client-started-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
      tags: (input) => ({
        prefix: 'wf',
        scenario: input.scenario,
      }),
      idempotency: (input) => ['wf', input.scenario],
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
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

  it('starts workflows with definition-level metadata without registering an implementation', async () => {
    const workflow = defineWorkflow({
      name: 'client-definition-metadata-workflow',
      input: t.object({ curriculumId: t.string() }),
      output: t.object({ caseId: t.string() }),
      tags: (input) => ({ curriculumId: input.curriculumId }),
      idempotency: (input) => ['workflow', input.curriculumId],
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    const run = await client.start(workflow, { curriculumId: 'curriculum-1' })
    const duplicate = await client.start(workflow, {
      curriculumId: 'curriculum-1',
    })
    const override = await client.start(
      workflow,
      { curriculumId: 'curriculum-2' },
      {
        tags: { curriculumId: 'override' },
        idempotencyKey: ['manual', 'curriculum-2'],
      },
    )

    expect(duplicate.id).toBe(run.id)
    expect(run).toMatchObject({
      tags: { curriculumId: 'curriculum-1' },
      idempotencyKey: ['workflow', 'curriculum-1'],
    })
    expect(override).toMatchObject({
      tags: { curriculumId: 'override' },
      idempotencyKey: ['manual', 'curriculum-2'],
    })
  })

  it('wraps workflow tags builder errors as user callback errors', async () => {
    const workflow = defineWorkflow({
      name: 'client-throwing-tags-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
      tags: () => {
        throw new Error('bad workflow tags')
      },
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    await expect(
      client.start(workflow, { scenario: 'alpha' }),
    ).rejects.toMatchObject({
      name: 'WorkflowUserCallbackError',
      message: 'bad workflow tags',
    })
    await expect(client.list()).resolves.toStrictEqual({ runs: [] })
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
    const task = defineTask({
      name: 'client-started-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      idempotency: (input) => ['task', input.text],
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
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

  it('starts tasks with definition-level idempotency without registering an implementation', async () => {
    const task = defineTask({
      name: 'client-definition-metadata-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      idempotency: (input) => ['task', input.text],
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    const run = await client.start(task, { text: 'alpha' })
    const duplicate = await client.start(task, { text: 'alpha' })
    const override = await client.start(
      task,
      { text: 'beta' },
      { idempotencyKey: ['manual', 'beta'] },
    )

    expect(duplicate.id).toBe(run.id)
    expect(run.idempotencyKey).toStrictEqual(['task', 'alpha'])
    expect(override.idempotencyKey).toStrictEqual(['manual', 'beta'])
  })

  it('wraps task tags builder errors as user callback errors', async () => {
    const task = defineTask({
      name: 'client-throwing-tags-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
      tags: () => {
        throw new Error('bad task tags')
      },
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    await expect(client.start(task, { text: 'alpha' })).rejects.toMatchObject({
      name: 'WorkflowUserCallbackError',
      message: 'bad task tags',
    })
    await expect(client.list()).resolves.toStrictEqual({ runs: [] })
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

  it('deletes terminal root runs through the client', async () => {
    const workflow = defineWorkflow({
      name: 'client-delete-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { scenario: 'alpha' })
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'alpha' },
    })

    await expect(client.deleteRun(run.id)).resolves.toStrictEqual({
      deleted: true,
    })
    await expect(client.get(run.id)).resolves.toBeUndefined()
  })

  it('retries terminal workflow runs with original input and tags', async () => {
    const workflow = defineWorkflow({
      name: 'client-retry-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      workflows: [implementation],
    })
    const run = await client.start(
      workflow,
      { scenario: 'alpha' },
      {
        tags: { tenantId: 'tenant-1' },
        idempotencyKey: ['workflow', 'alpha'],
      },
    )
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'alpha' },
    })

    const retried = await client.retry(run.id)

    expect(retried).toMatchObject({
      kind: 'workflow',
      name: workflow.name,
      workflowName: workflow.name,
      status: 'queued',
      input: { scenario: 'alpha' },
      tags: { tenantId: 'tenant-1' },
    })
    expect(retried.id).not.toBe(run.id)
    expect(retried.idempotencyKey).toBeUndefined()
    expect(runtime.inspect().continueRunCommands).toMatchObject([
      { payload: { runId: run.id } },
      { payload: { runId: retried.id } },
    ])
  })

  it('retries workflow runs using the canonical workflow name', async () => {
    const workflow = defineWorkflow({
      name: 'client-retry-canonical-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      workflows: [implementation],
    })
    const run = await runtime.store.createRun({
      name: 'custom display name',
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'alpha' },
    })

    const retried = await client.retry(run.id)

    expect(retried).toMatchObject({
      kind: 'workflow',
      name: workflow.name,
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
  })

  it('lets retry options override copied workflow tags', async () => {
    const workflow = defineWorkflow({
      name: 'client-retry-workflow-tag-override',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      workflows: [implementation],
    })
    const run = await client.start(
      workflow,
      { scenario: 'alpha' },
      { tags: { tenantId: 'tenant-1', source: 'original' } },
    )
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'alpha' },
    })

    const retried = await client.retry(run.id, {
      tags: { tenantId: 'tenant-2' },
    })

    expect(retried.tags).toStrictEqual({ tenantId: 'tenant-2' })
  })

  it('lets retry options set a workflow idempotency key', async () => {
    const workflow = defineWorkflow({
      name: 'client-retry-workflow-idempotency-override',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      workflows: [implementation],
    })
    const run = await client.start(
      workflow,
      { scenario: 'alpha' },
      { idempotencyKey: ['workflow', 'alpha'] },
    )
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'alpha' },
    })

    const retried = await client.retry(run.id, {
      idempotencyKey: ['retry', 'alpha'],
    })

    expect(retried.idempotencyKey).toStrictEqual(['retry', 'alpha'])
  })

  it('retries terminal task runs with original input and tags', async () => {
    const task = defineTask({
      name: 'client-retry-task',
      input: t.object({ text: t.string() }),
      output: t.object({ id: t.string() }),
    })
    const implementation = implementTask(task, {
      handler: async (_ctx, input) => ({ id: input.text }),
    })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      tasks: [implementation],
    })
    const run = await client.start(
      task,
      { text: 'alpha' },
      {
        tags: { tenantId: 'tenant-1' },
        idempotencyKey: ['task', 'alpha'],
      },
    )
    await runtime.store.completeRun({
      runId: run.id,
      output: { id: 'alpha' },
    })

    const retried = await client.retry(run.id)

    expect(retried).toMatchObject({
      kind: 'task',
      name: task.name,
      workflowName: task.name,
      taskName: task.name,
      status: 'queued',
      input: { text: 'alpha' },
      tags: { tenantId: 'tenant-1' },
    })
    expect(retried.id).not.toBe(run.id)
    expect(retried.idempotencyKey).toBeUndefined()
    expect(runtime.inspect().taskCommands).toMatchObject([
      { payload: { runId: run.id } },
      { payload: { runId: retried.id } },
    ])
  })

  it('refuses to retry non-terminal runs', async () => {
    const workflow = defineWorkflow({
      name: 'client-retry-live-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const implementation = implementWorkflow(workflow).finish(
      (_ctx, _outputs, input) => ({ caseId: input.scenario }),
    )
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient({
      ...runtime,
      workflows: [implementation],
    })
    const run = await client.start(workflow, { scenario: 'alpha' })

    await expect(client.retry(run.id)).rejects.toThrow(
      `Run [${run.id}] is not terminal`,
    )
  })

  it('refuses to retry unknown runs', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    await expect(client.retry('missing-run-id')).rejects.toThrow(
      'Run [missing-run-id] not found',
    )
  })

  it('refuses to retry child runs', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const parent = await runtime.store.createRun({
      workflowName: 'client-retry-parent',
      input: {},
    })
    const child = await runtime.store.createRun({
      workflowName: 'client-retry-child',
      input: {},
      parentRunId: parent.id,
      parentNodeName: 'child',
      rootRunId: parent.id,
    })
    await runtime.store.completeRun({ runId: child.id, output: { ok: true } })

    await expect(client.retry(child.id)).rejects.toThrow(
      `Run [${child.id}] is not a root run`,
    )
  })

  it('refuses to retry runs without a registered implementation', async () => {
    const workflow = defineWorkflow({
      name: 'client-retry-unregistered-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { scenario: 'alpha' })
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'alpha' },
    })

    await expect(client.retry(run.id)).rejects.toThrow(
      `No registered workflow implementation [${workflow.name}]`,
    )
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

  it('watches history and new events until the watched run terminates', async () => {
    const workflow = defineWorkflow({
      name: 'client-watch-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { scenario: 'alpha' })
    const queued = await runtime.store.listRunEvents({ runId: run.id })

    const iterator = client
      .watch(run.id, {
        afterEventId: queued.events[0]?.id,
        pollIntervalMs: 60_000,
      })
      [Symbol.asyncIterator]()

    const running = iterator.next()
    await runtime.store.markRunRunning({ runId: run.id })
    await expect(running).resolves.toMatchObject({
      done: false,
      value: { kind: 'run', status: 'running', runId: run.id },
    })

    const completed = iterator.next()
    await runtime.store.completeRun({
      runId: run.id,
      output: { caseId: 'alpha' },
    })
    await expect(completed).resolves.toMatchObject({
      done: false,
      value: { kind: 'run', status: 'completed', runId: run.id },
    })
    await expect(iterator.next()).resolves.toStrictEqual({
      done: true,
      value: undefined,
    })
  })

  it('ends immediately when watching a terminal run after its terminal event', async () => {
    vi.useFakeTimers()
    try {
      const workflow = defineWorkflow({
        name: 'client-watch-terminal-cursor-workflow',
        input: t.object({ scenario: t.string() }),
        output: t.object({ caseId: t.string() }),
      }).build()
      const runtime = createInMemoryWorkflowRuntime()
      const client = createWorkflowRuntimeClient(runtime)
      const run = await client.start(workflow, { scenario: 'alpha' })
      await runtime.store.completeRun({
        runId: run.id,
        output: { caseId: 'alpha' },
      })
      const terminalEventId = (
        await runtime.store.listRunEvents({ runId: run.id })
      ).events.at(-1)?.id
      const iterator = client
        .watch(run.id, {
          afterEventId: String(BigInt(terminalEventId!) + 1n),
          pollIntervalMs: 60_000,
        })
        [Symbol.asyncIterator]()

      const pending = iterator.next()
      await vi.advanceTimersByTimeAsync(0)

      await expect(
        Promise.race([pending, Promise.resolve('pending')]),
      ).resolves.toStrictEqual({ done: true, value: undefined })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the run-event wake listener registered while polling', async () => {
    vi.useFakeTimers()
    const abort = new AbortController()
    try {
      const runtime = createInMemoryWorkflowRuntime()
      const run = await runtime.store.createRun({
        workflowName: 'client-watch-wake-race',
        input: {},
      })
      const cursor = (
        await runtime.store.listRunEvents({ runId: run.id })
      ).events.at(-1)?.id
      let injected = false
      const client = createWorkflowRuntimeClient({
        ...runtime,
        store: {
          ...runtime.store,
          listRunEvents: async (params) => {
            const result = await runtime.store.listRunEvents(params)
            if (
              !injected &&
              params.runId === run.id &&
              params.afterEventId === cursor
            ) {
              injected = true
              await runtime.store.markRunRunning({ runId: run.id })
            }
            return result
          },
        },
      })
      const iterator = client
        .watch(run.id, {
          afterEventId: cursor,
          signal: abort.signal,
          pollIntervalMs: 60_000,
        })
        [Symbol.asyncIterator]()

      const pending = iterator.next()
      await vi.advanceTimersByTimeAsync(0)

      await expect(
        Promise.race([pending, Promise.resolve('pending')]),
      ).resolves.toMatchObject({
        done: false,
        value: { kind: 'run', status: 'running', runId: run.id },
      })
      await iterator.return?.()
    } finally {
      abort.abort()
      await vi.advanceTimersByTimeAsync(0)
      vi.useRealTimers()
    }
  })

  it('watches a run family but stops on the watched run terminal event', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const root = await runtime.store.createRun({
      workflowName: 'client-watch-family-root',
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
    const cursor = (
      await runtime.store.listRunEvents({ runId: root.id })
    ).events.at(-1)?.id

    const iterator = client
      .watch(root.id, {
        family: true,
        afterEventId: cursor,
        pollIntervalMs: 60_000,
      })
      [Symbol.asyncIterator]()
    const childQueued = iterator.next()
    const { childRun } = await runtime.store.ensureChildRun({
      runId: root.id,
      nodeName: 'child',
      childKey: '$self',
      childKind: 'workflow',
      childName: 'client-watch-family-child',
      input: {},
      rootRunId: root.rootRunId,
    })
    await expect(childQueued).resolves.toMatchObject({
      done: false,
      value: { kind: 'run', status: 'queued', runId: childRun.id },
    })

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'child', status: 'running', runId: root.id },
    })

    const childCompleted = iterator.next()
    await runtime.store.completeRun({ runId: childRun.id, output: {} })
    await expect(childCompleted).resolves.toMatchObject({
      done: false,
      value: { kind: 'run', status: 'completed', runId: childRun.id },
    })

    const rootCompleted = iterator.next()
    await runtime.store.completeRun({ runId: root.id, output: {} })
    await expect(rootCompleted).resolves.toMatchObject({
      done: false,
      value: { kind: 'run', status: 'completed', runId: root.id },
    })
    await expect(iterator.next()).resolves.toStrictEqual({
      done: true,
      value: undefined,
    })
  })

  it('ends watch iteration cleanly on abort and early consumer return', async () => {
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await runtime.store.createRun({
      workflowName: 'client-watch-abort',
      input: {},
    })
    const cursor = (
      await runtime.store.listRunEvents({ runId: run.id })
    ).events.at(-1)?.id
    const abort = new AbortController()
    const iterator = client
      .watch(run.id, {
        afterEventId: cursor,
        signal: abort.signal,
        pollIntervalMs: 60_000,
      })
      [Symbol.asyncIterator]()

    const pending = iterator.next()
    abort.abort()
    await expect(pending).resolves.toStrictEqual({
      done: true,
      value: undefined,
    })

    const seen: string[] = []
    await runtime.store.markRunRunning({ runId: run.id })
    for await (const event of client.watch(run.id, { afterEventId: cursor })) {
      seen.push(event.status)
      break
    }
    await runtime.store.completeRun({ runId: run.id, output: {} })
    await expect(
      Array.fromAsync(client.watch(run.id, { afterEventId: cursor })),
    ).resolves.toMatchObject([{ status: 'running' }, { status: 'completed' }])
    expect(seen).toStrictEqual(['running'])
  })

  it('falls back to polling when no wake event port is available', async () => {
    vi.useFakeTimers()
    try {
      const runtime = createInMemoryWorkflowRuntime()
      const client = createWorkflowRuntimeClient({
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
      })
      const run = await runtime.store.createRun({
        workflowName: 'client-watch-poll',
        input: {},
      })
      const cursor = (
        await runtime.store.listRunEvents({ runId: run.id })
      ).events.at(-1)?.id
      const iterator = client
        .watch(run.id, { afterEventId: cursor, pollIntervalMs: 25 })
        [Symbol.asyncIterator]()

      const pending = iterator.next()
      await vi.advanceTimersByTimeAsync(0)
      await runtime.store.markRunRunning({ runId: run.id })
      await vi.advanceTimersByTimeAsync(24)
      await expect(
        Promise.race([pending, Promise.resolve('pending')]),
      ).resolves.toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({
        done: false,
        value: { status: 'running' },
      })
      await iterator.return?.()
    } finally {
      vi.useRealTimers()
    }
  })
})
