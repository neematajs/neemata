import { PGlite } from '@electric-sql/pglite'
import { t } from '@nmtjs/type'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow } from '../src/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'

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
    input: t.object({ value: t.string() }),
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
