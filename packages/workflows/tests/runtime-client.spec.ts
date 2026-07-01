import {
  Container,
  createLogger,
  createValueInjectable,
} from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'

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

  it('lists runs through the store-backed client', async () => {
    const workflow = defineWorkflow({
      name: 'client-listed-workflow',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    }).build()
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)

    const alpha = await client.start(workflow, { scenario: 'alpha' }, {
      tags: { tenantId: 'tenant-1' },
    })
    await client.start(workflow, { scenario: 'beta' }, {
      tags: { tenantId: 'tenant-2' },
    })

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
})
