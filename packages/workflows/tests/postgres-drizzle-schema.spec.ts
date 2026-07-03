import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PGlite } from '@electric-sql/pglite'
import { t } from '@nmtjs/type'
import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { expectTypeOf, test, expect } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  WORKFLOW_POSTGRES_SCHEMA_MANIFEST,
  WORKFLOW_POSTGRES_SCHEMA_VERSION,
  type WorkflowPostgresConnection,
  type WorkflowPostgresQueryResult,
  verifyPostgresWorkflowSchema,
} from '../src/adapters/postgres.ts'
import { createSchema } from '../src/adapters/postgres/drizzle.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineTask, defineWorkflow } from '../src/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'

const createPgliteConnection = (db = new PGlite()) =>
  createPostgresWorkflowConnection(db)
const execFileAsync = promisify(execFile)
const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

async function exportDrizzleMigrationSql() {
  const result = await execFileAsync(
    pnpmBin,
    [
      'exec',
      'drizzle-kit',
      'export',
      '--dialect',
      'postgresql',
      '--schema',
      'tests/fixtures/drizzle-workflow-schema.ts',
    ],
    {
      cwd: packageRoot,
      maxBuffer: 1024 * 1024,
    },
  )
  return result.stdout
}

async function applySqlStatements(
  connection: WorkflowPostgresConnection,
  sql: string,
) {
  for (const statement of sql
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    await connection.query(statement)
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
      if (!failed && /INSERT\s+INTO\s+workflow_commands/i.test(sql)) {
        failed = true
        throw new Error('forced command insert failure')
      }

      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function completeRunAfterRunLoad(
  connection: WorkflowPostgresConnection,
  runId: string,
): WorkflowPostgresConnection {
  let completed = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      const shouldComplete =
        !completed &&
        /SELECT\s+\*\s+FROM\s+workflow_runs\s+WHERE\s+id\s+=\s+\$1/i.test(
          sql,
        ) &&
        params[0] === runId
      const result = await target.query(sql, params)
      if (shouldComplete) {
        completed = true
        await target.query(
          `
            UPDATE workflow_runs
            SET status = 'completed', output = $2::jsonb
            WHERE id = $1
          `,
          [runId, JSON.stringify({ ok: true })],
        )
      }
      return result as WorkflowPostgresQueryResult<T>
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function insertNodeAfterRunSnapshotLoad(
  connection: WorkflowPostgresConnection,
  runId: string,
): WorkflowPostgresConnection {
  let inserted = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      const shouldInsert =
        !inserted &&
        /^\s*SELECT\s+\*\s+FROM\s+workflow_runs\s+WHERE\s+id\s+=\s+\$1\s*$/i.test(
          sql,
        ) &&
        params[0] === runId
      const result = await target.query(sql, params)
      if (shouldInsert) {
        inserted = true
        await target.query(
          `
            INSERT INTO workflow_nodes (
              run_id, name, kind, status, attempt_count, version, created_at, updated_at
            )
            VALUES ($1, 'late-node', 'activity', 'pending', 0, 1, now(), now())
          `,
          [runId],
        )
      }
      return result as WorkflowPostgresQueryResult<T>
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function raceIdempotentRunInsert(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let raced = false
  const duplicateError = Object.assign(
    new Error('duplicate key value violates unique constraint'),
    { code: '23505' },
  )
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      if (!raced && /INSERT\s+INTO\s+workflow_runs/i.test(sql)) {
        raced = true
        await connection.query(sql, params)
        throw duplicateError
      }
      return connection.query<T>(sql, params)
    },
    transaction: (handler) =>
      connection.transaction((tx) => handler(raceIdempotentRunInsert(tx))),
  }
}

function raceNodeAttemptInsert(
  connection: WorkflowPostgresConnection,
  writer: WorkflowPostgresConnection = connection,
  state: {
    raced: boolean
    committed: boolean
    sql?: string
    params?: readonly unknown[]
  } = { raced: false, committed: false },
): WorkflowPostgresConnection {
  const duplicateError = Object.assign(
    new Error('duplicate key value violates unique constraint'),
    { code: '23505' },
  )
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      if (!state.raced && /INSERT\s+INTO\s+workflow_attempts/i.test(sql)) {
        state.raced = true
        state.sql = sql
        state.params = params
        throw duplicateError
      }
      return connection.query<T>(sql, params)
    },
    async transaction(handler) {
      try {
        return await connection.transaction((tx) =>
          handler(raceNodeAttemptInsert(tx, writer, state)),
        )
      } catch (error) {
        if (state.raced && !state.committed && state.sql && state.params) {
          state.committed = true
          await writer.query(state.sql, state.params)
          await writer.query(
            `
              UPDATE workflow_nodes
              SET status = 'waiting',
                  current_attempt_id = $3,
                  attempt_count = attempt_count + 1,
                  version = version + 1,
                  updated_at = now()
              WHERE run_id = $1 AND name = $2
            `,
            [state.params[1], state.params[2], state.params[0]],
          )
        }
        throw error
      }
    },
  }
}

function raceChildLinkInsert(
  connection: WorkflowPostgresConnection,
  params: {
    readonly identity: {
      readonly runId: string
      readonly nodeName: string
      readonly caseKey?: string
      readonly memberKey?: string
      readonly itemIndex?: number
      readonly itemKey?: string
    }
    readonly childKind: 'workflow' | 'task'
    readonly childName: string
    readonly input: unknown
    readonly parentRunId: string
    readonly parentNodeName: string
    readonly rootRunId: string
    readonly tags?: Readonly<Record<string, string>>
    readonly idempotencyKey?: readonly unknown[]
  },
): WorkflowPostgresConnection {
  let raced = false
  const key = JSON.stringify([
    params.identity.runId,
    params.identity.nodeName,
    params.identity.caseKey ?? null,
    params.identity.memberKey ?? null,
    params.identity.itemIndex ?? null,
    params.identity.itemKey ?? null,
  ])
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      const shouldRace =
        !raced &&
        /FROM\s+workflow_child_links/i.test(sql) &&
        queryParams[0] === key
      const result = await target.query<T>(sql, queryParams)
      if (shouldRace) {
        raced = true
        const childRunId = randomUUID()
        await connection.query(
          `
            INSERT INTO workflow_runs (
              id, kind, name, workflow_name, task_name, status, input,
              parent_run_id, parent_node_name, root_run_id, tags,
              idempotency_key, version, created_at, updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, 'queued', $6::jsonb,
              $7, $8, $9, $10::jsonb, $11::jsonb, 1, now(), now()
            )
          `,
          [
            childRunId,
            params.childKind,
            params.childName,
            params.childName,
            params.childKind === 'task' ? params.childName : null,
            JSON.stringify(params.input),
            params.parentRunId,
            params.parentNodeName,
            params.rootRunId,
            JSON.stringify(params.tags ?? {}),
            params.idempotencyKey
              ? JSON.stringify(params.idempotencyKey)
              : null,
          ],
        )
        await connection.query(
          `
            INSERT INTO workflow_child_links (
              identity_key, identity, parent_run_id, parent_node_name,
              child_run_id, child_kind, child_name, workflow_name, task_name,
              case_key, member_key, item_index, item_key
            )
            VALUES (
              $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
            )
          `,
          [
            key,
            JSON.stringify(params.identity),
            params.parentRunId,
            params.parentNodeName,
            childRunId,
            params.childKind,
            params.childName,
            params.childName,
            params.childKind === 'task' ? params.childName : null,
            params.identity.caseKey ?? null,
            params.identity.memberKey ?? null,
            params.identity.itemIndex ?? null,
            params.identity.itemKey ?? null,
          ],
        )
      }
      return result
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function raceMapItemsAfterSetLoad(
  connection: WorkflowPostgresConnection,
  params: {
    readonly runId: string
    readonly nodeName: string
    readonly items: readonly unknown[]
    readonly keys?: readonly (string | undefined)[]
  },
): WorkflowPostgresConnection {
  let raced = false
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      const shouldRace =
        !raced &&
        /FROM\s+workflow_map_item_sets/i.test(sql) &&
        queryParams[0] === params.runId &&
        queryParams[1] === params.nodeName
      const result = await connection.query<T>(sql, queryParams)
      if (shouldRace) {
        raced = true
        const keys = params.items.map((_, index) => params.keys?.[index])
        await connection.query(
          `
            INSERT INTO workflow_map_item_sets (run_id, node_name, keys)
            VALUES ($1, $2, $3::jsonb)
          `,
          [params.runId, params.nodeName, JSON.stringify(keys)],
        )
        for (const [index, item] of params.items.entries()) {
          const itemKey = params.keys?.[index]
          const identity = {
            runId: params.runId,
            nodeName: params.nodeName,
            itemIndex: index,
            ...(itemKey === undefined ? {} : { itemKey }),
          }
          const identityKey = JSON.stringify([
            params.runId,
            params.nodeName,
            null,
            null,
            index,
            itemKey ?? null,
          ])
          await connection.query(
            `
              INSERT INTO workflow_map_items (
                run_id, node_name, item_index, identity_key, identity,
                item_key, item, status
              )
              VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, 'pending')
            `,
            [
              params.runId,
              params.nodeName,
              index,
              identityKey,
              JSON.stringify(identity),
              itemKey ?? null,
              JSON.stringify(item),
            ],
          )
        }
      }
      return result
    },
    transaction: (handler) =>
      connection.transaction((tx) =>
        handler(raceMapItemsAfterSetLoad(tx, params)),
      ),
  }
}

function failChildLinkInsert(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (/INSERT\s+INTO\s+workflow_child_links/i.test(sql)) {
        throw new Error('forced child link insert failure')
      }
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function failMapItemInsert(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (/INSERT\s+INTO\s+workflow_map_items/i.test(sql)) {
        throw new Error('forced map item insert failure')
      }
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function rejectClientClockLeaseParams(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (
        /workflow_run_leases/i.test(sql) &&
        params.some((param) => param instanceof Date)
      ) {
        throw new Error('client clock lease param')
      }
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function rejectClientClockCommandParams(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (
        /UPDATE\s+workflow_commands/i.test(sql) &&
        params.some((param) => param instanceof Date)
      ) {
        throw new Error('client clock command param')
      }
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function failNodeUpdateAfterAttemptInsert(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let attemptInserted = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      if (/INSERT\s+INTO\s+workflow_attempts/i.test(sql)) {
        attemptInserted = true
      }
      if (
        attemptInserted &&
        /UPDATE\s+workflow_nodes\s+SET\s+status\s+=\s+'(?:running|waiting)'/i.test(
          sql,
        )
      ) {
        throw new Error('forced node update failure')
      }
      return target.query<T>(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

const primaryKeyColumns = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).primaryKeys.map((key) =>
    key.columns.map((column) => column.name),
  )

const primaryKeyNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).primaryKeys.map((key) => key.getName())

const uniqueConstraintNames = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).uniqueConstraints.map((key) => key.getName())

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
  expect(schema.tables.commands.payload.hasDefault).toBe(true)
  expect(primaryKeyColumns(schema.tables.nodes)).toContainEqual([
    'run_id',
    'name',
  ])
  expect(primaryKeyNames(schema.tables.nodes)).toContain('workflow_nodes_pkey')
  expect(primaryKeyColumns(schema.tables.mapItemSets)).toContainEqual([
    'run_id',
    'node_name',
  ])
  expect(primaryKeyNames(schema.tables.mapItemSets)).toContain(
    'workflow_map_item_sets_pkey',
  )
  expect(primaryKeyColumns(schema.tables.mapItems)).toContainEqual([
    'run_id',
    'node_name',
    'item_index',
  ])
  expect(primaryKeyNames(schema.tables.mapItems)).toContain(
    'workflow_map_items_pkey',
  )
  expect(uniqueConstraintNames(schema.tables.attempts)).toContain(
    'workflow_attempts_identity_key_key',
  )
  expect(uniqueConstraintNames(schema.tables.mapItems)).toContain(
    'workflow_map_items_identity_key_key',
  )
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
  expect(foreignKeys(schema.tables.commands)).toEqual(
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
      'workflow_attempts_node_idx',
      'workflow_child_links_parent_node_idx',
      'workflow_commands_run_idx',
      'workflow_commands_claim_idx',
    ]),
  )
  expect(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraints).toEqual(
    expect.arrayContaining([
      'workflow_attempts_identity_key_key',
      'workflow_map_items_identity_key_key',
      'workflow_commands_run_fk',
    ]),
  )
})

test('drizzle kit exports migration sql from app-owned schema file', async () => {
  const sql = await exportDrizzleMigrationSql()

  expect(sql).toContain('CREATE TYPE "workflow_run_kind"')
  expect(sql).toContain('CREATE TABLE "workflow_runs"')
  expect(sql).toContain('CREATE INDEX "workflow_runs_input_gin_idx"')
})

test('drizzle schema passes postgres workflow schema verification', async () => {
  const connection = createPgliteConnection()
  await applySqlStatements(connection, await exportDrizzleMigrationSql())
  await connection.query(
    `
      INSERT INTO workflow_schema_version (id, version)
      VALUES (1, $1)
    `,
    [WORKFLOW_POSTGRES_SCHEMA_VERSION],
  )

  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()
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

test('returns no activity claim for an empty activity filter', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })

  await expect(
    runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker',
      workflowNames: ['workflow-without-activities'],
      activityNames: [],
      leaseMs: 1000,
    }),
  ).resolves.toBeNull()
})

test('extends activity command leases with heartbeat', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const run = await runtime.store.createRun({
    workflowName: 'heartbeat-workflow',
    input: {},
  })
  const command = {
    kind: 'activityAttempt' as const,
    workflowName: 'heartbeat-workflow',
    activityName: 'content',
    runId: run.id,
    nodeName: 'content',
    attemptId: '00000000-0000-4000-8000-000000000002',
    leaseToken: 'attempt-lease',
    input: {},
  }

  await runtime.attemptExecutor.dispatchActivity(command)
  const claimed = await runtime.attemptExecutor.claimActivity({
    workerId: 'activity-worker-1',
    workflowNames: [command.workflowName],
    activityNames: [command.activityName],
    leaseMs: 20,
  })
  expect(claimed).not.toBeNull()

  await new Promise((resolve) => setTimeout(resolve, 10))
  await runtime.attemptExecutor.heartbeat(claimed!, 100)
  await new Promise((resolve) => setTimeout(resolve, 40))

  await expect(
    runtime.attemptExecutor.claimActivity({
      workerId: 'activity-worker-2',
      workflowNames: [command.workflowName],
      activityNames: [command.activityName],
      leaseMs: 20,
    }),
  ).resolves.toBeNull()
})

test('uses postgres-side timestamps for command claim, heartbeat, and release', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({
    connection: rejectClientClockCommandParams(connection),
  })
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'command-server-clock-workflow',
    input: {},
  })
  const command = {
    kind: 'activityAttempt' as const,
    workflowName: 'command-server-clock-workflow',
    activityName: 'content',
    runId: run.id,
    nodeName: 'content',
    attemptId: '00000000-0000-4000-8000-000000000012',
    leaseToken: 'attempt-lease',
    input: {},
  }

  await runtime.attemptExecutor.dispatchActivity(command)
  const claimed = await runtime.attemptExecutor.claimActivity({
    workerId: 'activity-worker-1',
    workflowNames: [command.workflowName],
    activityNames: [command.activityName],
    leaseMs: 1000,
  })
  expect(claimed).not.toBeNull()

  const claimedLease = await connection.query<{
    lease_expires_at: Date
    db_now: Date
  }>(
    `
      SELECT lease_expires_at, now() AS db_now
      FROM workflow_commands
      WHERE attempt_id = $1
    `,
    [command.attemptId],
  )
  const claimedDelta =
    claimedLease.rows[0]!.lease_expires_at.getTime() -
    claimedLease.rows[0]!.db_now.getTime()
  expect(claimedDelta).toBeGreaterThan(800)
  expect(claimedDelta).toBeLessThan(1200)

  await runtime.attemptExecutor.heartbeat(claimed!, 2000)
  const heartbeatLease = await connection.query<{
    lease_expires_at: Date
    db_now: Date
  }>(
    `
      SELECT lease_expires_at, now() AS db_now
      FROM workflow_commands
      WHERE attempt_id = $1
    `,
    [command.attemptId],
  )
  const heartbeatDelta =
    heartbeatLease.rows[0]!.lease_expires_at.getTime() -
    heartbeatLease.rows[0]!.db_now.getTime()
  expect(heartbeatDelta).toBeGreaterThan(1800)
  expect(heartbeatDelta).toBeLessThan(2200)

  await runtime.attemptExecutor.release(claimed!)
  const released = await connection.query<{
    run_at: Date
    db_now: Date
    lease_expires_at: Date | null
  }>(
    `
      SELECT run_at, lease_expires_at, now() AS db_now
      FROM workflow_commands
      WHERE attempt_id = $1
    `,
    [command.attemptId],
  )
  const releaseDelta =
    released.rows[0]!.run_at.getTime() - released.rows[0]!.db_now.getTime()
  expect(released.rows[0]!.lease_expires_at).toBeNull()
  expect(releaseDelta).toBeGreaterThanOrEqual(0)
  expect(releaseDelta).toBeLessThan(500)
})

test('renews run leases', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const run = await runtime.store.createRun({
    workflowName: 'postgres-lease-renewal-workflow',
    input: {},
  })
  const lease = await runtime.store.acquireRunLease({
    runId: run.id,
    leaseMs: 20,
  })
  expect(lease).not.toBeUndefined()

  await new Promise((resolve) => setTimeout(resolve, 10))
  await runtime.store.renewRunLease(lease!, 100)
  await new Promise((resolve) => setTimeout(resolve, 40))

  await expect(
    runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 20,
    }),
  ).resolves.toBeUndefined()
})

test('uses postgres-side expiry when acquiring run leases', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'postgres-server-clock-lease-workflow',
    input: {},
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: rejectClientClockLeaseParams(connection),
  })

  await expect(
    runtime.store.acquireRunLease({
      runId: run.id,
      leaseMs: 10_000,
    }),
  ).resolves.not.toBeUndefined()
})

test('uses postgres-side expiry when renewing run leases', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'postgres-server-clock-renew-workflow',
    input: {},
  })
  const lease = await setupRuntime.store.acquireRunLease({
    runId: run.id,
    leaseMs: 10_000,
  })
  expect(lease).not.toBeUndefined()
  const runtime = createPostgresWorkflowRuntime({
    connection: rejectClientClockLeaseParams(connection),
  })

  await expect(
    runtime.store.renewRunLease(lease!, 10_000),
  ).resolves.not.toBeUndefined()
})

test('does not let failRun overwrite a concurrently completed run', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'terminal-guard-workflow',
    input: {},
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: completeRunAfterRunLoad(connection, run.id),
  })

  const failed = await runtime.store.failRun({
    runId: run.id,
    error: new Error('too-late'),
  })

  expect(failed?.status).toBe('completed')
  expect(failed?.output).toStrictEqual({ ok: true })
})

test('loads a populated run snapshot with the same mapped shape as stored rows', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const run = await runtime.store.createRun({
    workflowName: 'snapshot-shape-workflow',
    input: { scenario: 'alpha' },
    tags: { tenantId: 'tenant-1' },
    idempotencyKey: ['snapshot-shape-workflow', 'alpha'],
  })
  const node = await runtime.store.createNode({
    runId: run.id,
    name: 'content',
    kind: 'activity',
  })
  const attempt = await runtime.store.createAttempt({
    runId: run.id,
    nodeName: node.name,
    input: { scenario: 'alpha' },
  })
  const childNode = await runtime.store.createNode({
    runId: run.id,
    name: 'child',
    kind: 'workflow',
  })
  const child = await runtime.store.ensureChildRun({
    identity: { runId: run.id, nodeName: childNode.name },
    childKind: 'workflow',
    childName: 'snapshot-child',
    input: { child: true },
    parentRunId: run.id,
    parentNodeName: childNode.name,
    rootRunId: run.rootRunId,
  })
  const mapNode = await runtime.store.createNode({
    runId: run.id,
    name: 'items',
    kind: 'mapTask',
  })
  const mapItems = await runtime.store.ensureMapItems({
    runId: run.id,
    nodeName: mapNode.name,
    items: [{ item: 'one' }],
    keys: ['one'],
  })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)

  expect(snapshot?.run).toStrictEqual(run)
  expect(snapshot?.attempts).toStrictEqual([attempt])
  expect(snapshot?.childLinks).toStrictEqual([child.childLink])
  expect(snapshot?.mapItems).toStrictEqual(mapItems.items)
  expect(snapshot?.nodes).toHaveLength(3)
  expect(snapshot?.nodes[0]).toMatchObject({
    runId: node.runId,
    name: node.name,
    kind: node.kind,
    status: 'running',
    currentAttemptId: attempt.id,
    attemptCount: 1,
    version: 2,
  })
  expect(snapshot?.nodes[0]?.createdAt).toBeInstanceOf(Date)
  expect(snapshot?.nodes[0]?.updatedAt).toBeInstanceOf(Date)
  expect(snapshot?.nodes.slice(1)).toStrictEqual([childNode, mapNode])
})

test('loads a run snapshot from one consistent postgres statement', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'consistent-snapshot-workflow',
    input: {},
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: insertNodeAfterRunSnapshotLoad(connection, run.id),
  })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)

  expect(snapshot?.run.id).toBe(run.id)
  expect(snapshot?.nodes).toStrictEqual([])
})

test('returns the existing idempotent run after an insert race', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({
    connection: raceIdempotentRunInsert(connection),
  })

  const run = await runtime.store.createRun({
    workflowName: 'racy-idempotent-workflow',
    input: { scenario: 'alpha' },
    idempotencyKey: ['racy-idempotent-workflow', 'alpha'],
  })

  expect(run.workflowName).toBe('racy-idempotent-workflow')
  expect(run.input).toStrictEqual({ scenario: 'alpha' })
  const rows = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_runs',
  )
  expect(rows.rows[0]?.count).toBe(1)
})

test('returns the existing node attempt after an insert race', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'racy-attempt-workflow',
    input: {},
  })
  await setupRuntime.store.createNode({
    runId: run.id,
    name: 'content',
    kind: 'activity',
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: raceNodeAttemptInsert(connection),
  })

  const result = await runtime.store.ensureNodeAttempt({
    identity: { runId: run.id, nodeName: 'content' },
    kind: 'activity',
    input: { text: 'alpha' },
    idempotencyKey: ['content', 'alpha'],
  })

  expect(result.created).toBe(false)
  expect(result.attempt.input).toStrictEqual({ text: 'alpha' })
  const rows = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_attempts',
  )
  expect(rows.rows[0]?.count).toBe(1)
})

test('returns the existing child run after a child link insert race', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const parent = await setupRuntime.store.createRun({
    workflowName: 'racy-child-parent',
    input: {},
  })
  await setupRuntime.store.createNode({
    runId: parent.id,
    name: 'child',
    kind: 'workflow',
  })
  const childParams = {
    identity: { runId: parent.id, nodeName: 'child' },
    childKind: 'workflow' as const,
    childName: 'racy-child-workflow',
    input: { scenario: 'alpha' },
    parentRunId: parent.id,
    parentNodeName: 'child',
    rootRunId: parent.rootRunId,
    idempotencyKey: ['racy-child-workflow', 'alpha'],
  }
  const runtime = createPostgresWorkflowRuntime({
    connection: raceChildLinkInsert(connection, childParams),
  })

  const result = await runtime.store.ensureChildRun(childParams)

  expect(result.created).toBe(false)
  expect(result.childRun.input).toStrictEqual({ scenario: 'alpha' })
  expect(result.childLink.childRunId).toBe(result.childRun.id)
  const links = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_child_links',
  )
  expect(links.rows[0]?.count).toBe(1)
})

test('returns existing map items after a map set insert race', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'racy-map-workflow',
    input: {},
  })
  await setupRuntime.store.createNode({
    runId: run.id,
    name: 'items',
    kind: 'mapTask',
  })
  const items = [{ text: 'alpha' }, { text: 'beta' }]
  const runtime = createPostgresWorkflowRuntime({
    connection: raceMapItemsAfterSetLoad(connection, {
      runId: run.id,
      nodeName: 'items',
      items,
      keys: ['alpha', 'beta'],
    }),
  })

  const result = await runtime.store.ensureMapItems({
    runId: run.id,
    nodeName: 'items',
    items,
    keys: ['alpha', 'beta'],
  })

  expect(result.created).toBe(false)
  expect(result.items.map((item) => item.item)).toStrictEqual(items)
  const rows = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_map_items',
  )
  expect(rows.rows[0]?.count).toBe(2)
})

test('rolls back child run creation when child link insert fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const parent = await setupRuntime.store.createRun({
    workflowName: 'atomic-child-parent',
    input: {},
  })
  await setupRuntime.store.createNode({
    runId: parent.id,
    name: 'child',
    kind: 'workflow',
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: failChildLinkInsert(connection),
  })

  await expect(
    runtime.store.ensureChildRun({
      identity: { runId: parent.id, nodeName: 'child' },
      childKind: 'workflow',
      childName: 'atomic-child-workflow',
      input: { scenario: 'alpha' },
      parentRunId: parent.id,
      parentNodeName: 'child',
      rootRunId: parent.rootRunId,
    }),
  ).rejects.toThrow('forced child link insert failure')

  const runs = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_runs',
  )
  const links = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_child_links',
  )
  expect(runs.rows[0]?.count).toBe(1)
  expect(links.rows[0]?.count).toBe(0)
})

test('rolls back map item set creation when map item insert fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'atomic-map-workflow',
    input: {},
  })
  await setupRuntime.store.createNode({
    runId: run.id,
    name: 'items',
    kind: 'mapTask',
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: failMapItemInsert(connection),
  })

  await expect(
    runtime.store.ensureMapItems({
      runId: run.id,
      nodeName: 'items',
      items: [{ text: 'alpha' }],
      keys: ['alpha'],
    }),
  ).rejects.toThrow('forced map item insert failure')

  const sets = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_map_item_sets',
  )
  const items = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_map_items',
  )
  expect(sets.rows[0]?.count).toBe(0)
  expect(items.rows[0]?.count).toBe(0)
})

test('rolls back createAttempt when node update fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'atomic-create-attempt-workflow',
    input: {},
  })
  await setupRuntime.store.createNode({
    runId: run.id,
    name: 'content',
    kind: 'activity',
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: failNodeUpdateAfterAttemptInsert(connection),
  })

  await expect(
    runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      input: { text: 'alpha' },
    }),
  ).rejects.toThrow('forced node update failure')

  const attempts = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_attempts',
  )
  const nodes = await connection.query<{
    status: string
    current_attempt_id: string | null
  }>('SELECT status, current_attempt_id FROM workflow_nodes')
  expect(attempts.rows[0]?.count).toBe(0)
  expect(nodes.rows[0]).toStrictEqual({
    status: 'pending',
    current_attempt_id: null,
  })
})

test('rolls back ensureNodeAttempt when node update fails', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const setupRuntime = createPostgresWorkflowRuntime({ connection })
  const run = await setupRuntime.store.createRun({
    workflowName: 'atomic-ensure-attempt-workflow',
    input: {},
  })
  await setupRuntime.store.createNode({
    runId: run.id,
    name: 'content',
    kind: 'activity',
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: failNodeUpdateAfterAttemptInsert(connection),
  })

  await expect(
    runtime.store.ensureNodeAttempt({
      identity: { runId: run.id, nodeName: 'content' },
      kind: 'activity',
      input: { text: 'alpha' },
    }),
  ).rejects.toThrow('forced node update failure')

  const attempts = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_attempts',
  )
  const nodes = await connection.query<{
    status: string
    current_attempt_id: string | null
  }>('SELECT status, current_attempt_id FROM workflow_nodes')
  expect(attempts.rows[0]?.count).toBe(0)
  expect(nodes.rows[0]).toStrictEqual({
    status: 'pending',
    current_attempt_id: null,
  })
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

  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()
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
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

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
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query('DROP INDEX workflow_runs_tags_gin_idx')

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_runs_tags_gin_idx',
  )
})

test('verifies postgres schema index definitions', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query('DROP INDEX workflow_runs_idempotency_idx')
  await connection.query(
    'CREATE INDEX workflow_runs_idempotency_idx ON workflow_runs (created_at)',
  )

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Invalid workflow Postgres schema indexes: workflow_runs_idempotency_idx',
  )
})

test('verifies postgres schema index direction', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query('DROP INDEX workflow_commands_claim_idx')
  await connection.query(`
    CREATE INDEX workflow_commands_claim_idx
    ON workflow_commands (kind, priority, run_at, created_at, id)
  `)

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Invalid workflow Postgres schema indexes: workflow_commands_claim_idx',
  )
})

test('verifies postgres schema column definitions', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query(
    'ALTER TABLE workflow_runs ALTER COLUMN input DROP NOT NULL',
  )

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Invalid workflow Postgres schema columns: workflow_runs.input',
  )
})

test('verifies postgres schema identity uniqueness constraints', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query(
    'ALTER TABLE workflow_attempts DROP CONSTRAINT workflow_attempts_identity_key_key',
  )

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_attempts_identity_key_key',
  )

  await installPostgresWorkflowSchemaForTesting(connection)
  await connection.query(
    'ALTER TABLE workflow_map_items DROP CONSTRAINT workflow_map_items_identity_key_key',
  )

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_map_items_identity_key_key',
  )
})

test('verifies postgres schema constraint definitions', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query(
    'ALTER TABLE workflow_attempts DROP CONSTRAINT workflow_attempts_identity_key_key',
  )
  await connection.query(`
    ALTER TABLE workflow_attempts
    ADD CONSTRAINT workflow_attempts_identity_key_key
    CHECK (identity_key IS NOT NULL)
  `)

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Invalid workflow Postgres schema constraints: workflow_attempts_identity_key_key',
  )
})
