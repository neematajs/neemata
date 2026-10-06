import { PGlite } from '@electric-sql/pglite'
import * as Schema from 'effect/Schema'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow } from '../src/effect/index.ts'
import {
  createWorkflowRuntimeClient,
  WorkflowIdempotencyConflictError,
} from '../src/runtime/index.ts'

const createPgliteConnection = () =>
  createPostgresWorkflowConnection(new PGlite())

// Simulates losing the idempotency precheck race: the first duplicate-check
// select sees nothing, forcing the insert to hit the unique index for real.
function hideFirstIdempotencyPrecheck(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let hidden = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query(sql, params = []) {
      if (!hidden && /WHERE\s+idempotency_key\s*=/i.test(sql)) {
        hidden = true
        return { rows: [] }
      }
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

test('idempotent start racing a concurrent duplicate returns the existing run', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const workflow = defineWorkflow({
    name: 'insert-race-idempotent-start',
    input: Schema.Struct({ value: Schema.String }),
  }).build()

  const client = createWorkflowRuntimeClient(
    createPostgresWorkflowRuntime({ connection }),
  )
  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { idempotencyKey: ['insert-race', 1] },
  )

  const racingClient = createWorkflowRuntimeClient(
    createPostgresWorkflowRuntime({
      connection: hideFirstIdempotencyPrecheck(connection),
    }),
  )
  const second = await racingClient.start(
    workflow,
    { value: 'alpha' },
    { idempotencyKey: ['insert-race', 1] },
  )

  expect(second.id).toBe(first.id)

  const commands = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_commands WHERE run_id = $1',
    [first.id],
  )
  expect(commands.rows[0]?.count).toBe(1)
})

test('idempotent start racing a holder with different input throws the typed conflict', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const holder = await createPostgresWorkflowRuntime({
    connection,
  }).store.createRun({
    workflowName: 'insert-race-conflicting-start',
    input: { value: 'alpha' },
    idempotencyKey: ['insert-race', 2],
  })

  const racing = createPostgresWorkflowRuntime({
    connection: hideFirstIdempotencyPrecheck(connection),
  })
  const conflict = await racing.store
    .createRun({
      workflowName: 'insert-race-conflicting-start',
      input: { value: 'beta' },
      idempotencyKey: ['insert-race', 2],
    })
    .then(
      () => undefined,
      (error) => error,
    )

  expect(conflict).toBeInstanceOf(WorkflowIdempotencyConflictError)
  expect(conflict).toMatchObject({ runId: holder.id, key: ['insert-race', 2] })
})

test('child start racing a key holder with different input throws the typed conflict', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const parent = await runtime.store.createRun({
    workflowName: 'insert-race-child-parent',
    input: {},
  })
  await runtime.store.createNode({
    runId: parent.id,
    name: 'child',
    kind: 'workflow',
  })
  await runtime.store.ensureNodeChildren({
    runId: parent.id,
    nodeName: 'child',
    children: [{ childKey: '$self', kind: 'workflow' }],
  })
  const holder = await runtime.store.createRun({
    workflowName: 'insert-race-child',
    input: { value: 'alpha' },
    idempotencyKey: ['insert-race', 3],
  })

  const racing = createPostgresWorkflowRuntime({
    connection: hideFirstIdempotencyPrecheck(connection),
  })
  const conflict = await racing.store
    .ensureChildRun({
      runId: parent.id,
      nodeName: 'child',
      childKey: '$self',
      childKind: 'workflow',
      childName: 'insert-race-child',
      input: { value: 'beta' },
      rootRunId: parent.rootRunId,
      idempotencyKey: ['insert-race', 3],
    })
    .then(
      () => undefined,
      (error) => error,
    )

  expect(conflict).toBeInstanceOf(WorkflowIdempotencyConflictError)
  expect(conflict).toMatchObject({
    runId: holder.id,
    status: 'queued',
    key: ['insert-race', 3],
    runnableName: 'insert-race-child',
  })
  const snapshot = await runtime.store.loadRunSnapshot(parent.id)
  expect(snapshot?.children).toMatchObject([
    { childKey: '$self', status: 'pending' },
  ])
  expect(snapshot?.children[0]?.childRunId).toBeUndefined()
})
