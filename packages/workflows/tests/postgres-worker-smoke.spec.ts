import { PGlite } from '@electric-sql/pglite'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import {
  defineWorkflow,
  implementWorkflow,
  runWorkflowWorker,
} from '../src/effect/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'
import { fromPromise } from './support/effect.ts'

function createTestContext() {
  return Context.empty()
}

test('runs direct child and mapWorkflow through postgres workers', async () => {
  const connection = createPostgresWorkflowConnection(new PGlite())
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const client = createWorkflowRuntimeClient(runtime)
  const context = createTestContext()

  const childWorkflow = defineWorkflow({
    name: 'postgres-smoke-child',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  }).build()
  const parentWorkflow = defineWorkflow({
    name: 'postgres-smoke-parent',
    input: Schema.Struct({
      scenario: Schema.String,
      items: Schema.Array(Schema.String),
    }),
    output: Schema.Struct({
      primaryId: Schema.String,
      ids: Schema.Array(Schema.String),
    }),
  })
    .workflow('primary', childWorkflow)
    .mapWorkflow('children', childWorkflow, {
      item: Schema.String,
    })
    .build()

  const childImpl = implementWorkflow(childWorkflow).finish((_outputs, input) =>
    fromPromise(() => ({ id: `child:${input.text}` })),
  )
  const parentImpl = implementWorkflow(parentWorkflow)
    .primary(childWorkflow, {
      input: (_outputs, input) => ({ text: input.scenario }),
    })
    .children(childWorkflow, {
      items: ({ primary }, input) =>
        input.items.map((item) => `${primary.id}:${item}`),
      input: (_outputs, item) => ({ text: item }),
    })
    .finish(({ primary, children }) =>
      fromPromise(() => ({
        primaryId: primary.id,
        ids: children.items.map((item) => item.output.id),
      })),
    )

  const run = await client.start(parentWorkflow, {
    scenario: 'alpha',
    items: ['one', 'two'],
  })

  await runWorkflowWorker({
    ...runtime,
    context,
    workflows: [parentImpl, childImpl],
    workerId: 'postgres-smoke-worker',
  })

  const snapshot = await client.get(run.id)
  expect(snapshot?.run.status).toBe('completed')
  expect(snapshot?.run.output).toStrictEqual({
    primaryId: 'child:alpha',
    ids: ['child:child:alpha:one', 'child:child:alpha:two'],
  })
  const childRunIds = snapshot?.children
    .map((child) => child.childRunId)
    .filter((id): id is string => id !== undefined)
  expect(childRunIds).toHaveLength(3)
  expect(snapshot?.nodes.map((node) => node.status)).toStrictEqual([
    'completed',
    'completed',
  ])
})
