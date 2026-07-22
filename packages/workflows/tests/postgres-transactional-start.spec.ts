import { PGlite } from '@electric-sql/pglite'
import { t } from '@nmtjs/type'
import { expect, test } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineTask, defineWorkflow } from '../src/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'

const createPgliteConnection = () =>
  createPostgresWorkflowConnection(new PGlite())

async function createHarness() {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await connection.query(`
    CREATE TABLE domain_records (
      id text PRIMARY KEY,
      run_id uuid
    )
  `)
  const client = createWorkflowRuntimeClient(
    createPostgresWorkflowRuntime({ connection }),
  )
  return { connection, client }
}

async function countRows(
  connection: WorkflowPostgresConnection,
  table: string,
) {
  const result = await connection.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  )
  return result.rows[0]?.count ?? 0
}

const workflow = defineWorkflow({
  name: 'transactional-start-workflow',
  input: t.object({ value: t.string() }),
}).build()

const task = defineTask({
  name: 'transactional-start-task',
  input: t.object({ value: t.string() }),
  output: t.object({ value: t.string() }),
})

test('workflow start through a caller transaction commits atomically with domain writes', async () => {
  const { connection, client } = await createHarness()

  const runId = await connection.transaction(async (tx) => {
    const run = await client.start(
      workflow,
      { value: 'alpha' },
      { connection: tx },
    )
    // the pre-commit snapshot already carries the id, so the domain row can
    // reference the run inside the same transaction
    await tx.query('INSERT INTO domain_records (id, run_id) VALUES ($1, $2)', [
      'record-1',
      run.id,
    ])
    return run.id
  })

  const runs = await connection.query<{ id: string; status: string }>(
    'SELECT id, status FROM workflow_runs',
  )
  expect(runs.rows).toEqual([{ id: runId, status: 'queued' }])
  expect(await countRows(connection, 'workflow_commands')).toBe(1)
  const domain = await connection.query<{ run_id: string }>(
    'SELECT run_id FROM domain_records',
  )
  expect(domain.rows).toEqual([{ run_id: runId }])
})

test('workflow start disappears when the caller transaction rolls back', async () => {
  const { connection, client } = await createHarness()

  await expect(
    connection.transaction(async (tx) => {
      await tx.query(
        'INSERT INTO domain_records (id, run_id) VALUES ($1, NULL)',
        ['record-2'],
      )
      await client.start(workflow, { value: 'beta' }, { connection: tx })
      throw new Error('domain-abort')
    }),
  ).rejects.toThrow('domain-abort')

  expect(await countRows(connection, 'workflow_runs')).toBe(0)
  expect(await countRows(connection, 'workflow_commands')).toBe(0)
  expect(await countRows(connection, 'domain_records')).toBe(0)
})

test('task start through a caller transaction rolls back all scaffolding', async () => {
  const { connection, client } = await createHarness()

  await expect(
    connection.transaction(async (tx) => {
      await client.start(task, { value: 'gamma' }, { connection: tx })
      throw new Error('task-abort')
    }),
  ).rejects.toThrow('task-abort')

  expect(await countRows(connection, 'workflow_runs')).toBe(0)
  expect(await countRows(connection, 'workflow_nodes')).toBe(0)
  expect(await countRows(connection, 'workflow_attempts')).toBe(0)
  expect(await countRows(connection, 'workflow_commands')).toBe(0)

  const run = await connection.transaction((tx) =>
    client.start(task, { value: 'gamma' }, { connection: tx }),
  )
  expect(run.status).toBe('queued')
  expect(await countRows(connection, 'workflow_runs')).toBe(1)
  expect(await countRows(connection, 'workflow_commands')).toBe(1)
})

test('a failed start leaves the caller transaction usable', async () => {
  const { connection, client } = await createHarness()

  // conflicting input under the same idempotency key → start() throws
  await client.start(
    workflow,
    { value: 'original' },
    { idempotencyKey: ['conflict-key'] },
  )

  await connection.transaction(async (tx) => {
    await expect(
      client.start(
        workflow,
        { value: 'different' },
        { idempotencyKey: ['conflict-key'], connection: tx },
      ),
    ).rejects.toThrow('Conflicting idempotent run')
    // the conflict never enters SQL error state, so the caller's
    // transaction continues and commits
    await tx.query(
      'INSERT INTO domain_records (id, run_id) VALUES ($1, NULL)',
      ['record-3'],
    )
  })

  expect(await countRows(connection, 'domain_records')).toBe(1)
  expect(await countRows(connection, 'workflow_runs')).toBe(1)
})
