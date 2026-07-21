import { PGlite } from '@electric-sql/pglite'
import { t } from '@nmtjs/type'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createWorkflowRuntimeClient,
  WorkflowRunConflictError,
} from '../src/runtime/index.ts'

const createPgliteConnection = () =>
  createPostgresWorkflowConnection(new PGlite())

const workflow = defineWorkflow({
  name: 'unique-start-workflow',
  input: t.object({ value: t.string() }),
}).build()

async function createHarness() {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const client = createWorkflowRuntimeClient(
    createPostgresWorkflowRuntime({ connection }),
  )
  return { connection, client }
}

async function markTerminal(
  connection: WorkflowPostgresConnection,
  runId: string,
  status = 'completed',
) {
  await connection.query(
    'UPDATE workflow_runs SET status = $2::workflow_run_status WHERE id = $1',
    [runId, status],
  )
}

// Simulates losing the uniqueness precheck race, forcing the insert to hit
// the partial unique index for real.
function hideFirstUniquePrecheck(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let hidden = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query(sql, params = []) {
      if (!hidden && /WHERE\s+unique_key\s*=/i.test(sql)) {
        hidden = true
        return { rows: [] }
      }
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

test('active scope rejects a duplicate while the holder is non-terminal', async () => {
  const { connection, client } = await createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1] } },
  )

  const conflict = await client
    .start(workflow, { value: 'beta' }, { unique: { key: ['turn', 1] } })
    .then(
      () => undefined,
      (error) => error,
    )
  expect(conflict).toBeInstanceOf(WorkflowRunConflictError)
  expect(conflict.runId).toBe(first.id)
  expect(conflict.scope).toBe('active')

  // a different key is unaffected
  await client.start(
    workflow,
    { value: 'gamma' },
    { unique: { key: ['turn', 2] } },
  )
})

test('active scope frees the key once the holder is terminal', async () => {
  const { connection, client } = await createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1] } },
  )
  await markTerminal(connection, first.id)

  const second = await client.start(
    workflow,
    { value: 'beta' },
    { unique: { key: ['turn', 1] } },
  )
  expect(second.id).not.toBe(first.id)
  expect(second.unique).toEqual({
    key: ['turn', 1],
    scope: 'active',
    behavior: 'reject',
  })
})

test('join returns the conflicting run regardless of input', async () => {
  const { client } = await createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1], behavior: 'join' } },
  )
  const joined = await client.start(
    workflow,
    { value: 'entirely-different' },
    { unique: { key: ['turn', 1], behavior: 'join' } },
  )
  expect(joined.id).toBe(first.id)
  expect(joined.input).toEqual({ value: 'alpha' })
})

test("scope 'all' holds the key across terminal transitions", async () => {
  const { connection, client } = await createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['once', 1], scope: 'all' } },
  )
  await markTerminal(connection, first.id)

  await expect(
    client.start(
      workflow,
      { value: 'beta' },
      { unique: { key: ['once', 1], scope: 'all' } },
    ),
  ).rejects.toThrow(WorkflowRunConflictError)

  const joined = await client.start(
    workflow,
    { value: 'beta' },
    { unique: { key: ['once', 1], scope: 'all', behavior: 'join' } },
  )
  expect(joined.id).toBe(first.id)
})

test('definition-level unique builder applies without start options', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const uniqueWorkflow = defineWorkflow({
    name: 'unique-definition-workflow',
    input: t.object({ entityId: t.string() }),
    unique: {
      key: (input) => ['entity', input.entityId],
      behavior: 'join',
    },
  }).build()
  const client = createWorkflowRuntimeClient(
    createPostgresWorkflowRuntime({ connection }),
  )

  const first = await client.start(uniqueWorkflow, { entityId: 'a' })
  const joined = await client.start(uniqueWorkflow, { entityId: 'a' })
  const other = await client.start(uniqueWorkflow, { entityId: 'b' })

  expect(joined.id).toBe(first.id)
  expect(other.id).not.toBe(first.id)
})

test('losing the precheck race still resolves through the index', async () => {
  const { connection, client } = await createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1], behavior: 'join' } },
  )

  const racingClient = createWorkflowRuntimeClient(
    createPostgresWorkflowRuntime({
      connection: hideFirstUniquePrecheck(connection),
    }),
  )
  const joined = await racingClient.start(
    workflow,
    { value: 'beta' },
    { unique: { key: ['turn', 1], behavior: 'join' } },
  )
  expect(joined.id).toBe(first.id)
})

test('a rejected unique start leaves the caller transaction usable', async () => {
  const { connection, client } = await createHarness()

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1] } },
  )

  await connection.query(
    'CREATE TABLE unique_domain_probe (id text PRIMARY KEY)',
  )
  await connection.transaction(async (tx) => {
    await expect(
      client.start(
        workflow,
        { value: 'beta' },
        { unique: { key: ['turn', 1] }, connection: tx },
      ),
    ).rejects.toThrow(WorkflowRunConflictError)
    await tx.query('INSERT INTO unique_domain_probe (id) VALUES ($1)', ['kept'])
  })

  const probe = await connection.query('SELECT id FROM unique_domain_probe')
  expect(probe.rows).toEqual([{ id: 'kept' }])
  const runs = await connection.query<{ id: string }>(
    'SELECT id FROM workflow_runs',
  )
  expect(runs.rows).toEqual([{ id: first.id }])
})

test('retry rehydrates the stored unique constraint', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const implementation = implementWorkflow(workflow).finish(() => undefined)
  const client = createWorkflowRuntimeClient({
    ...createPostgresWorkflowRuntime({ connection }),
    workflows: [implementation],
  })

  const first = await client.start(
    workflow,
    { value: 'alpha' },
    { unique: { key: ['turn', 1] } },
  )
  await markTerminal(connection, first.id, 'failed')

  const retried = await client.retry(first.id)
  expect(retried.id).not.toBe(first.id)
  expect(retried.unique).toEqual({
    key: ['turn', 1],
    scope: 'active',
    behavior: 'reject',
  })

  // the retried run holds the key again
  await expect(
    client.start(workflow, { value: 'beta' }, { unique: { key: ['turn', 1] } }),
  ).rejects.toThrow(WorkflowRunConflictError)
})
