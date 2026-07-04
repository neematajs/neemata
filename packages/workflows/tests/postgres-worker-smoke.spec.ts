import { PGlite } from '@electric-sql/pglite'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createWorkflowRuntimeClient,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

function createTestContainer() {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  return new Container({ logger })
}

test('runs direct child and mapWorkflow through postgres workers', async () => {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const client = createWorkflowRuntimeClient(runtime)
  const container = createTestContainer()

  const childWorkflow = defineWorkflow({
    name: 'postgres-smoke-child',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  }).build()
  const parentWorkflow = defineWorkflow({
    name: 'postgres-smoke-parent',
    input: t.object({
      scenario: t.string(),
      items: t.array(t.string()),
    }),
    output: t.object({
      primaryId: t.string(),
      ids: t.array(t.string()),
    }),
  })
    .workflow('primary', childWorkflow)
    .mapWorkflow('children', childWorkflow, {
      item: t.string(),
      mode: 'wait-all',
    })
    .build()

  const childImpl = implementWorkflow(childWorkflow).finish(
    (_ctx, _outputs, input) => ({ id: `child:${input.text}` }),
  )
  const parentImpl = implementWorkflow(parentWorkflow)
    .primary(childWorkflow, {
      input: (_ctx, _outputs, input) => ({ text: input.scenario }),
    })
    .children(childWorkflow, {
      items: (_ctx, { primary }, input) =>
        input.items.map((item) => `${primary.id}:${item}`),
      input: (_ctx, _outputs, item) => ({ text: item }),
    })
    .finish((_ctx, { primary, children }) => ({
      primaryId: primary.id,
      ids: children.items.map((item) => item.output.id),
    }))

  const run = await client.start(parentWorkflow, {
    scenario: 'alpha',
    items: ['one', 'two'],
  })

  await runWorkflowWorker({
    ...runtime,
    container,
    workflows: [parentImpl, childImpl],
    workerId: 'postgres-smoke-worker',
    maxIdleClaims: 3,
  })

  const snapshot = await client.get(run.id)
  expect(snapshot?.run.status).toBe('completed')
  expect(snapshot?.run.output).toStrictEqual({
    primaryId: 'child:alpha',
    ids: ['child:child:alpha:one', 'child:child:alpha:two'],
  })
  expect(snapshot?.childLinks).toHaveLength(3)
  expect(snapshot?.nodes.map((node) => node.status)).toStrictEqual([
    'completed',
    'completed',
  ])
})
