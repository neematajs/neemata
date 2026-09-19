import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

const text = t.object({ text: t.string() })

const createTestContainer = () =>
  new Container({
    logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
  })

async function settle(
  runtime: ReturnType<typeof createInMemoryWorkflowRuntime>,
  workflows: Parameters<typeof runWorkflowWorker>[0]['workflows'],
) {
  const container = createTestContainer()
  for (let pass = 0; pass < 3; pass++) {
    await runWorkflowWorker({ ...runtime, container, workflows, workerId: 'c' })
    await runExecutionWorker({
      ...runtime,
      container,
      workflows,
      tasks: [],
      workerId: 'e',
    })
  }
}

describe('workflow coordinator regressions', () => {
  it('treats a completed node named __proto__ as done', async () => {
    const workflow = defineWorkflow({
      name: 'proto-node-workflow',
      input: text,
      output: text,
    })
      .activity('__proto__', { input: text, output: text })
      .build()
    const implementation = implementWorkflow(workflow)
      ['__proto__'](async (_ctx, input) => input)
      .finish((_ctx, outputs) => outputs['__proto__'])
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { text: 'alpha' })

    await settle(runtime, [implementation])

    const snapshot = await client.get(run.id)
    expect(snapshot?.run.status).toBe('completed')
    expect(snapshot?.run.output).toEqual({ text: 'alpha' })
  })

  it('calls a node input mapper with its node as the receiver', async () => {
    const workflow = defineWorkflow({
      name: 'receiver-workflow',
      input: text,
      output: text,
    })
      .activity('content', { input: text, output: text })
      .build()
    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => input, {
        input(this: { name: string }, _ctx, _outputs, input) {
          return { text: `${this.name}:${input.text}` }
        },
      })
      .finish((_ctx, { content }) => content)
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const run = await client.start(workflow, { text: 'alpha' })

    await settle(runtime, [implementation])

    const snapshot = await client.get(run.id)
    expect(snapshot?.run.output).toEqual({ text: 'content:alpha' })
  })
})
