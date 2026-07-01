import { getTableName } from 'drizzle-orm'
import { PGlite } from '@electric-sql/pglite'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { expectTypeOf, test, expect } from 'vitest'
import { t } from '@nmtjs/type'

import { createSchema } from '../src/adapters/postgres/drizzle.ts'
import {
  createPostgresWorkflowRuntime,
  installPostgresWorkflowSchemaForTesting,
  WORKFLOW_POSTGRES_SCHEMA_MANIFEST,
  WORKFLOW_POSTGRES_SCHEMA_VERSION,
  type WorkflowPostgresConnection,
  verifyPostgresWorkflowSchema,
} from '../src/adapters/postgres.ts'
import {
  defineTask,
  defineWorkflow,
} from '../src/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'

function createPgliteConnection(db = new PGlite()): WorkflowPostgresConnection {
  return {
    query: (sql, params = []) => db.query(sql, [...params]),
    transaction: (handler) =>
      db.transaction((tx) =>
        handler({
          query: (sql, params = []) => tx.query(sql, [...params]),
          transaction: (nested) => nested(createPgliteConnection(db)),
        }),
      ),
  }
}

function failNextCommandInsert(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let failed = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (
        !failed &&
        /INSERT\s+INTO\s+workflow_commands/i.test(sql)
      ) {
        failed = true
        throw new Error('forced command insert failure')
      }

      return target.query(sql, params)
    },
    transaction: (handler) =>
      target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

const primaryKeyColumns = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).primaryKeys.map((key) =>
    key.columns.map((column) => column.name),
  )

const foreignKeys = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).foreignKeys.map((key) => {
    const reference = key.reference()
    return {
      columns: reference.columns.map((column) => column.name),
      foreignTable: getTableName(reference.foreignTable),
      foreignColumns: reference.foreignColumns.map((column) => column.name),
      onDelete: key.onDelete,
    }
  })

test('creates drizzle schema with canonical runtime names', () => {
  const schema = createSchema()
  const WorkflowRunTable = schema.tables.runs
  const WorkflowNodeTable = schema.tables.nodes
  const SchemaVersionTable = schema.tables.schemaVersion

  expectTypeOf(schema).toHaveProperty('tables')
  expectTypeOf(schema).toHaveProperty('enums')
  expectTypeOf(schema.tables).toHaveProperty('runs')
  expectTypeOf(schema.tables).toHaveProperty('nodes')
  expectTypeOf(schema.tables).toHaveProperty('schemaVersion')

  expect(getTableName(WorkflowRunTable)).toBe('workflow_runs')
  expect(getTableConfig(WorkflowRunTable).schema).toBeUndefined()
  expect(getTableName(SchemaVersionTable)).toBe('workflow_schema_version')
  expect(SchemaVersionTable.id.primary).toBe(true)
  expect(SchemaVersionTable.version.notNull).toBe(true)
  expect(SchemaVersionTable.installedAt.notNull).toBe(true)
  expect(WorkflowRunTable.id.columnType).toBe('PgUUID')
  expect(WorkflowRunTable.parentRunId.columnType).toBe('PgUUID')
  expect(WorkflowRunTable.rootRunId.columnType).toBe('PgUUID')
  expect(WorkflowRunTable.kind.enumValues).toStrictEqual(['workflow', 'task'])
  expect(WorkflowRunTable.status.enumValues).toStrictEqual([
    'queued',
    'running',
    'waiting',
    'cancelling',
    'cancelled',
    'failed',
    'completed',
  ])
  expect(getTableName(WorkflowNodeTable)).toBe('workflow_nodes')
  expect(getTableConfig(WorkflowNodeTable).schema).toBeUndefined()
  expect(WorkflowNodeTable.runId.columnType).toBe('PgUUID')
  expect(WorkflowNodeTable.currentAttemptId.columnType).toBe('PgUUID')
  expect(WorkflowNodeTable.kind.enumValues).toStrictEqual([
    'activity',
    'task',
    'workflow',
    'branch',
    'parallel',
    'mapTask',
    'mapWorkflow',
  ])
  expect(WorkflowNodeTable.status.enumValues).toStrictEqual([
    'pending',
    'running',
    'waiting',
    'cancelling',
    'cancelled',
    'failed',
    'completed',
  ])
  expect(schema.tables.attempts.status.enumValues).toStrictEqual([
    'started',
    'completed',
    'failed',
    'timedOut',
    'cancelled',
  ])
  expect(schema.tables.attempts.id.columnType).toBe('PgUUID')
  expect(schema.tables.attempts.runId.columnType).toBe('PgUUID')
  expect(schema.tables.childLinks.parentRunId.columnType).toBe('PgUUID')
  expect(schema.tables.childLinks.childRunId.columnType).toBe('PgUUID')
  expect(schema.tables.mapItemSets.runId.columnType).toBe('PgUUID')
  expect(schema.tables.mapItems.runId.columnType).toBe('PgUUID')
  expect(schema.tables.mapItems.childRunId.columnType).toBe('PgUUID')
  expect(schema.tables.mapItems.attemptId.columnType).toBe('PgUUID')
  expect(schema.tables.runLeases.runId.columnType).toBe('PgUUID')
  expect(schema.tables.commands.id.columnType).toBe('PgUUID')
  expect(schema.tables.commands.kind.enumValues).toStrictEqual([
    'continue',
    'activity',
    'task',
  ])
  expect(schema.tables.commands.runId.columnType).toBe('PgUUID')
  expect(schema.tables.commands.attemptId.columnType).toBe('PgUUID')
  expect(primaryKeyColumns(schema.tables.nodes)).toContainEqual([
    'run_id',
    'name',
  ])
  expect(primaryKeyColumns(schema.tables.mapItemSets)).toContainEqual([
    'run_id',
    'node_name',
  ])
  expect(primaryKeyColumns(schema.tables.mapItems)).toContainEqual([
    'run_id',
    'node_name',
    'item_index',
  ])
  expect(foreignKeys(schema.tables.runs)).toEqual(
    expect.arrayContaining([
      {
        columns: ['parent_run_id'],
        foreignTable: 'workflow_runs',
        foreignColumns: ['id'],
        onDelete: 'cascade',
      },
      {
        columns: ['root_run_id'],
        foreignTable: 'workflow_runs',
        foreignColumns: ['id'],
        onDelete: 'cascade',
      },
      {
        columns: ['parent_run_id', 'parent_node_name'],
        foreignTable: 'workflow_nodes',
        foreignColumns: ['run_id', 'name'],
        onDelete: 'cascade',
      },
    ]),
  )
  expect(foreignKeys(schema.tables.nodes)).toEqual(
    expect.arrayContaining([
      {
        columns: ['run_id'],
        foreignTable: 'workflow_runs',
        foreignColumns: ['id'],
        onDelete: 'cascade',
      },
      {
        columns: ['current_attempt_id'],
        foreignTable: 'workflow_attempts',
        foreignColumns: ['id'],
        onDelete: 'set null',
      },
    ]),
  )
  expect(foreignKeys(schema.tables.attempts)).toEqual(
    expect.arrayContaining([
      {
        columns: ['run_id', 'node_name'],
        foreignTable: 'workflow_nodes',
        foreignColumns: ['run_id', 'name'],
        onDelete: 'cascade',
      },
    ]),
  )
  expect(foreignKeys(schema.tables.childLinks)).toEqual(
    expect.arrayContaining([
      {
        columns: ['parent_run_id', 'parent_node_name'],
        foreignTable: 'workflow_nodes',
        foreignColumns: ['run_id', 'name'],
        onDelete: 'cascade',
      },
      {
        columns: ['child_run_id'],
        foreignTable: 'workflow_runs',
        foreignColumns: ['id'],
        onDelete: 'cascade',
      },
    ]),
  )
  expect(foreignKeys(schema.tables.mapItemSets)).toEqual(
    expect.arrayContaining([
      {
        columns: ['run_id', 'node_name'],
        foreignTable: 'workflow_nodes',
        foreignColumns: ['run_id', 'name'],
        onDelete: 'cascade',
      },
    ]),
  )
  expect(foreignKeys(schema.tables.mapItems)).toEqual(
    expect.arrayContaining([
      {
        columns: ['run_id', 'node_name'],
        foreignTable: 'workflow_map_item_sets',
        foreignColumns: ['run_id', 'node_name'],
        onDelete: 'cascade',
      },
      {
        columns: ['child_run_id'],
        foreignTable: 'workflow_runs',
        foreignColumns: ['id'],
        onDelete: 'set null',
      },
      {
        columns: ['attempt_id'],
        foreignTable: 'workflow_attempts',
        foreignColumns: ['id'],
        onDelete: 'set null',
      },
    ]),
  )
  expect(foreignKeys(schema.tables.runLeases)).toEqual(
    expect.arrayContaining([
      {
        columns: ['run_id'],
        foreignTable: 'workflow_runs',
        foreignColumns: ['id'],
        onDelete: 'cascade',
      },
    ]),
  )
  expect(schema.tables.childLinks.childKind.enumValues).toStrictEqual([
    'workflow',
    'task',
  ])
  expect(schema.tables.mapItems.status.enumValues).toStrictEqual([
    'pending',
    'running',
    'waiting',
    'cancelling',
    'cancelled',
    'failed',
    'completed',
  ])
  expect(schema.enums.runKind.enumName).toBe('workflow_run_kind')
  expect(schema.enums.runKind.schema).toBeUndefined()
  expect(schema.enums.nodeKind.enumName).toBe('workflow_node_kind')
  expect(schema.enums.nodeKind.schema).toBeUndefined()
  expect(schema.enums.runStatus.enumName).toBe('workflow_run_status')
  expect(schema.enums.runStatus.schema).toBeUndefined()
  expect(schema.enums.nodeStatus.enumName).toBe('workflow_node_status')
  expect(schema.enums.nodeStatus.schema).toBeUndefined()
  expect(schema.enums.attemptStatus.enumName).toBe('workflow_attempt_status')
  expect(schema.enums.attemptStatus.schema).toBeUndefined()
  expect(schema.enums.commandKind.enumName).toBe('workflow_command_kind')
  expect(schema.enums.commandKind.schema).toBeUndefined()
  expect(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexes).toEqual(
    expect.arrayContaining([
      'workflow_runs_idempotency_idx',
      'workflow_runs_input_gin_idx',
      'workflow_runs_tags_gin_idx',
      'workflow_commands_claim_idx',
    ]),
  )
})

test('uses one postgres command table for all command kinds', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)

  const commandTables = await connection.query<{ tablename: string }>(
    `
      SELECT tablename
      FROM pg_tables
      WHERE tablename LIKE 'workflow_%commands'
      ORDER BY tablename
    `,
  )

  expect(commandTables.rows.map((row) => row.tablename)).toStrictEqual([
    'workflow_commands',
  ])
})

test('rolls back workflow start when initial command insert fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({
    connection: failNextCommandInsert(connection),
  })
  const client = createWorkflowRuntimeClient(runtime)
  const workflow = defineWorkflow({
    name: 'atomic-workflow-start',
    input: t.object({ value: t.string() }),
    output: t.object({ value: t.string() }),
  }).build()

  await expect(client.start(workflow, { value: 'alpha' })).rejects.toThrow(
    'forced command insert failure',
  )

  const runs = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_runs',
  )
  const commands = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_commands',
  )
  expect(runs.rows[0]?.count).toBe(0)
  expect(commands.rows[0]?.count).toBe(0)
})

test('rolls back task start when initial command insert fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({
    connection: failNextCommandInsert(connection),
  })
  const client = createWorkflowRuntimeClient(runtime)
  const task = defineTask({
    name: 'atomic-task-start',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })

  await expect(client.start(task, { text: 'alpha' })).rejects.toThrow(
    'forced command insert failure',
  )

  const runs = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_runs',
  )
  const nodes = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_nodes',
  )
  const attempts = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_attempts',
  )
  const commands = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_commands',
  )
  expect(runs.rows[0]?.count).toBe(0)
  expect(nodes.rows[0]?.count).toBe(0)
  expect(attempts.rows[0]?.count).toBe(0)
  expect(commands.rows[0]?.count).toBe(0)
})

test('creates postgres runtime schema with relational constraints', async () => {
  const db = new PGlite()
  await installPostgresWorkflowSchemaForTesting(createPgliteConnection(db))

  const constraints = await db.query<{ conname: string }>(`
    SELECT conname
    FROM pg_constraint
    WHERE conname LIKE 'workflow_%'
    ORDER BY conname
  `)
  const names = constraints.rows.map((row) => row.conname)

  expect(names).toEqual(
    expect.arrayContaining([
      'workflow_runs_parent_run_fk',
      'workflow_runs_root_run_fk',
      'workflow_runs_parent_node_fk',
      'workflow_nodes_run_fk',
      'workflow_nodes_current_attempt_fk',
      'workflow_attempts_node_fk',
      'workflow_child_links_parent_node_fk',
      'workflow_child_links_child_run_fk',
      'workflow_map_item_sets_node_fk',
      'workflow_map_items_set_fk',
      'workflow_map_items_child_run_fk',
      'workflow_map_items_attempt_fk',
      'workflow_run_leases_run_fk',
    ]),
  )
})

test('keeps postgres runtime schema setup explicit', async () => {
  const connection = createPgliteConnection()
  const runtime = createPostgresWorkflowRuntime({ connection })

  await expect(runtime.store.listRuns()).rejects.toThrow(/workflow_runs/)
  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects',
  )

  await installPostgresWorkflowSchemaForTesting(connection)

  await expect(verifyPostgresWorkflowSchema(connection)).resolves.toBeUndefined()
  await expect(runtime.store.listRuns()).resolves.toStrictEqual({ runs: [] })
})

test('writes and verifies postgres schema version', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)

  const installed = await connection.query<{
    id: number
    version: number
  }>(
    `
      SELECT id, version
      FROM workflow_schema_version
      WHERE id = 1
    `,
  )

  expect(installed.rows).toMatchObject([
    {
      id: 1,
      version: WORKFLOW_POSTGRES_SCHEMA_VERSION,
    },
  ])
  await expect(verifyPostgresWorkflowSchema(connection)).resolves.toBeUndefined()

  await connection.query('DELETE FROM workflow_schema_version')
  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema version',
  )

  await connection.query(
    `
      INSERT INTO workflow_schema_version (id, version)
      VALUES (1, 0)
    `,
  )
  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    `Unsupported workflow Postgres schema version [0], expected [${WORKFLOW_POSTGRES_SCHEMA_VERSION}]`,
  )

  await connection.query(
    `
      UPDATE workflow_schema_version
      SET version = $2
      WHERE id = $1
    `,
    [1, WORKFLOW_POSTGRES_SCHEMA_VERSION + 1],
  )
  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    `Unsupported workflow Postgres schema version [${WORKFLOW_POSTGRES_SCHEMA_VERSION + 1}], expected [${WORKFLOW_POSTGRES_SCHEMA_VERSION}]`,
  )
})

test('verifies postgres schema indexes', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(verifyPostgresWorkflowSchema(connection)).resolves.toBeUndefined()

  await connection.query('DROP INDEX workflow_runs_tags_gin_idx')

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_runs_tags_gin_idx',
  )
})
