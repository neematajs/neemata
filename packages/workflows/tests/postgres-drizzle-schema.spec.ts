import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { PGlite } from '@electric-sql/pglite'
import { Container, createLogger } from '@nmtjs/core'
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
import {
  createWorkflowRuntimeClient,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

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

function captureRetentionLockQueries(
  connection: WorkflowPostgresConnection,
  statements: string[],
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params = [],
    ) {
      statements.push(sql)
      if (
        /pg_try_advisory_xact_lock\s*\(\s*hashtext\('workflow_prune'\)\s*\)/i.test(
          sql,
        )
      ) {
        return Promise.resolve({
          rows: [{ acquired: true }],
        } as unknown as WorkflowPostgresQueryResult<T>)
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

function captureWorkflowStatements(
  connection: WorkflowPostgresConnection,
  statements: string[],
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      statements.push(sql)
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function raceIdempotentRunInsert(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  let raced = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      // a concurrent starter wins the race first; the intercepted insert then
      // genuinely conflicts (ON CONFLICT DO NOTHING → zero rows)
      if (!raced && /INSERT\s+INTO\s+workflow_runs/i.test(sql)) {
        raced = true
        await connection.query(sql, params)
      }
      return target.query<T>(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function raceChildAttemptInsert(
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
          handler(raceChildAttemptInsert(tx, writer, state)),
        )
      } catch (error) {
        if (state.raced && !state.committed && state.sql && state.params) {
          state.committed = true
          await writer.query(state.sql, state.params)
          await writer.query(
            `
              UPDATE workflow_node_children
              SET status = 'running',
                  current_attempt_id = $4,
                  attempt_count = 1,
                  version = version + 1,
                  updated_at = now()
              WHERE run_id = $1 AND node_name = $2 AND child_key = $3
            `,
            [
              state.params[1],
              state.params[2],
              state.params[3],
              state.params[0],
            ],
          )
        }
        throw error
      }
    },
  }
}

function raceChildRunAfterChildLoad(
  connection: WorkflowPostgresConnection,
  params: {
    readonly runId: string
    readonly nodeName: string
    readonly childKey: string
    readonly childKind: 'workflow' | 'task'
    readonly childName: string
    readonly input: unknown
    readonly rootRunId: string
    readonly tags?: Readonly<Record<string, string>>
    readonly idempotencyKey?: readonly unknown[]
  },
): WorkflowPostgresConnection {
  let raced = false
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      const shouldRace =
        !raced &&
        /FROM\s+workflow_node_children/i.test(sql) &&
        queryParams[0] === params.runId &&
        queryParams[1] === params.nodeName &&
        queryParams[2] === params.childKey
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
            params.runId,
            params.nodeName,
            params.rootRunId,
            JSON.stringify(params.tags ?? {}),
            params.idempotencyKey
              ? JSON.stringify(params.idempotencyKey)
              : null,
          ],
        )
        await connection.query(
          `
            UPDATE workflow_node_children
            SET child_run_id = $4,
                status = 'running',
                version = version + 1,
                updated_at = now()
            WHERE run_id = $1 AND node_name = $2 AND child_key = $3
          `,
          [params.runId, params.nodeName, params.childKey, childRunId],
        )
      }
      return result
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function raceNodeChildrenAfterLoad(
  connection: WorkflowPostgresConnection,
  params: {
    readonly runId: string
    readonly nodeName: string
    readonly children: readonly {
      readonly childKey: string
      readonly kind: 'activity' | 'task' | 'workflow'
      readonly ordinal?: number
      readonly itemKey?: string
      readonly item?: unknown
    }[]
  },
  state: { raced: boolean } = { raced: false },
): WorkflowPostgresConnection {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      queryParams: readonly unknown[] = [],
    ): Promise<WorkflowPostgresQueryResult<T>> {
      const shouldRace =
        !state.raced &&
        /FROM\s+workflow_node_children/i.test(sql) &&
        queryParams.length === 2 &&
        queryParams[0] === params.runId &&
        queryParams[1] === params.nodeName
      const result = await connection.query<T>(sql, queryParams)
      if (shouldRace) {
        state.raced = true
        for (const child of params.children) {
          await connection.query(
            `
              INSERT INTO workflow_node_children (
                run_id, node_name, child_key, kind, status, ordinal,
                item_key, item, attempt_count, version, created_at, updated_at
              )
              VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7::jsonb, 0, 1, now(), now())
            `,
            [
              params.runId,
              params.nodeName,
              child.childKey,
              child.kind,
              child.ordinal ?? 0,
              child.itemKey ?? null,
              child.item === undefined ? null : JSON.stringify(child.item),
            ],
          )
        }
      }
      return result
    },
    transaction: (handler) =>
      connection.transaction((tx) =>
        handler(raceNodeChildrenAfterLoad(tx, params, state)),
      ),
  }
}

function failChildRunLinkUpdate(
  connection: WorkflowPostgresConnection,
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (/UPDATE\s+workflow_node_children\s+SET\s+child_run_id/i.test(sql)) {
        throw new Error('forced child run link failure')
      }
      return target.query(sql, params)
    },
    transaction: (handler) => target.transaction((tx) => handler(wrap(tx))),
  })

  return wrap(connection)
}

function failNodeChildInsert(
  connection: WorkflowPostgresConnection,
  childKey: string,
): WorkflowPostgresConnection {
  const wrap = (
    target: WorkflowPostgresConnection,
  ): WorkflowPostgresConnection => ({
    query(sql, params = []) {
      if (
        /INSERT\s+INTO\s+workflow_node_children/i.test(sql) &&
        params.includes(childKey)
      ) {
        throw new Error('forced node child insert failure')
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

function failChildUpdateAfterAttemptInsert(
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
        /UPDATE\s+workflow_node_children\s+SET\s+current_attempt_id/i.test(sql)
      ) {
        throw new Error('forced child update failure')
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
  const WorkflowScheduleTable = schema.tables.schedules

  expectTypeOf(schema).toHaveProperty('tables')
  expectTypeOf(schema).toHaveProperty('enums')
  expectTypeOf(schema.tables).toHaveProperty('runs')
  expectTypeOf(schema.tables).toHaveProperty('nodes')
  expectTypeOf(schema.tables).toHaveProperty('schemaVersion')
  expectTypeOf(schema.tables).toHaveProperty('schedules')
  expect(WORKFLOW_POSTGRES_SCHEMA_VERSION).toBe(1)

  expect(getTableName(WorkflowRunTable)).toBe('workflow_runs')
  expect(getTableConfig(WorkflowRunTable).schema).toBeUndefined()
  expect(getTableName(SchemaVersionTable)).toBe('workflow_schema_version')
  expect(getTableName(WorkflowScheduleTable)).toBe('workflow_schedules')
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
  expect(WorkflowScheduleTable.id.columnType).toBe('PgUUID')
  expect(WorkflowScheduleTable.runnableKind.enumValues).toStrictEqual([
    'workflow',
    'task',
  ])
  expect(WorkflowScheduleTable.enabled.notNull).toBe(true)
  expect(WorkflowScheduleTable.nextRunAt.notNull).toBe(true)
  expect(getTableName(WorkflowNodeTable)).toBe('workflow_nodes')
  expect(getTableConfig(WorkflowNodeTable).schema).toBeUndefined()
  expect(WorkflowNodeTable.runId.columnType).toBe('PgUUID')
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
  expect(schema.tables.attempts.childKey.columnType).toBe('PgText')
  expect(schema.tables.attempts.childKey.notNull).toBe(true)
  expect(getTableName(schema.tables.nodeChildren)).toBe(
    'workflow_node_children',
  )
  expect(schema.tables.nodeChildren.runId.columnType).toBe('PgUUID')
  expect(schema.tables.nodeChildren.childKey.columnType).toBe('PgText')
  expect(schema.tables.nodeChildren.childKey.notNull).toBe(true)
  expect(schema.tables.nodeChildren.childRunId.columnType).toBe('PgUUID')
  expect(schema.tables.nodeChildren.currentAttemptId.columnType).toBe('PgUUID')
  expect(schema.tables.nodeChildren.ordinal.notNull).toBe(true)
  expect(schema.tables.nodeChildren.attemptCount.notNull).toBe(true)
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
  expect(primaryKeyColumns(schema.tables.nodeChildren)).toContainEqual([
    'run_id',
    'node_name',
    'child_key',
  ])
  expect(primaryKeyNames(schema.tables.nodeChildren)).toContain(
    'workflow_node_children_pkey',
  )
  expect(uniqueConstraintNames(schema.tables.attempts)).toContain(
    'workflow_attempts_child_attempt_key',
  )
  expect(
    getTableConfig(schema.tables.attempts)
      .uniqueConstraints.find(
        (key) => key.getName() === 'workflow_attempts_child_attempt_key',
      )
      ?.columns.map((column) => column.name),
  ).toStrictEqual(['run_id', 'node_name', 'child_key', 'attempt_number'])
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
  expect(foreignKeys(schema.tables.nodes)).toStrictEqual([
    {
      columns: ['run_id'],
      foreignTable: 'workflow_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
    },
  ])
  expect(foreignKeys(schema.tables.attempts)).toStrictEqual([
    {
      columns: ['run_id', 'node_name'],
      foreignTable: 'workflow_nodes',
      foreignColumns: ['run_id', 'name'],
      onDelete: 'cascade',
    },
  ])
  expect(foreignKeys(schema.tables.nodeChildren)).toStrictEqual([
    {
      columns: ['run_id'],
      foreignTable: 'workflow_runs',
      foreignColumns: ['id'],
      onDelete: 'cascade',
    },
    {
      columns: ['run_id', 'node_name'],
      foreignTable: 'workflow_nodes',
      foreignColumns: ['run_id', 'name'],
      onDelete: 'cascade',
    },
    {
      columns: ['child_run_id'],
      foreignTable: 'workflow_runs',
      foreignColumns: ['id'],
      onDelete: 'set null',
    },
    {
      columns: ['current_attempt_id'],
      foreignTable: 'workflow_attempts',
      foreignColumns: ['id'],
      onDelete: 'set null',
    },
  ])
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
  expect(schema.tables.nodeChildren.kind.enumValues).toStrictEqual([
    'activity',
    'task',
    'workflow',
  ])
  expect(schema.tables.nodeChildren.status.enumValues).toStrictEqual([
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
  expect(schema.enums.nodeChildKind.enumName).toBe('workflow_node_child_kind')
  expect(schema.enums.nodeChildKind.schema).toBeUndefined()
  expect(schema.enums.runStatus.enumName).toBe('workflow_run_status')
  expect(schema.enums.runStatus.schema).toBeUndefined()
  expect(schema.enums.nodeStatus.enumName).toBe('workflow_node_status')
  expect(schema.enums.nodeStatus.schema).toBeUndefined()
  expect(schema.enums.attemptStatus.enumName).toBe('workflow_attempt_status')
  expect(schema.enums.attemptStatus.schema).toBeUndefined()
  expect(schema.enums.commandKind.enumName).toBe('workflow_command_kind')
  expect(schema.enums.commandKind.schema).toBeUndefined()
  // manifest ⇄ drizzle agreement: same tables, same enums, same enum labels
  expect(
    [...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.tables].sort((left, right) =>
      left.localeCompare(right),
    ),
  ).toStrictEqual(
    Object.values(schema.tables)
      .map((table) => getTableName(table))
      .sort((left, right) => left.localeCompare(right)),
  )
  expect(
    [...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enums].sort((left, right) =>
      left.localeCompare(right),
    ),
  ).toStrictEqual(
    Object.values(schema.enums)
      .map((schemaEnum) => schemaEnum.enumName)
      .sort((left, right) => left.localeCompare(right)),
  )
  for (const schemaEnum of Object.values(schema.enums)) {
    expect(
      WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enumValues[
        schemaEnum.enumName as keyof typeof WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enumValues
      ],
    ).toStrictEqual(schemaEnum.enumValues)
  }
  expect(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexes).toEqual(
    expect.arrayContaining([
      'workflow_runs_idempotency_idx',
      'workflow_runs_parent_idx',
      'workflow_runs_root_idx',
      'workflow_runs_prune_idx',
      'workflow_attempts_node_idx',
      'workflow_node_children_node_idx',
      'workflow_node_children_child_run_idx',
      'workflow_commands_run_idx',
      'workflow_commands_claim_idx',
      'workflow_commands_dead_idx',
      'workflow_commands_continue_dedup_idx',
      'workflow_schedules_due_idx',
    ]),
  )
  // search GIN indexes are opt-in: never required, always definition-checked
  expect(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.optionalIndexes).toStrictEqual([
    'workflow_runs_input_gin_idx',
    'workflow_runs_tags_gin_idx',
  ])
  expect(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraints).toEqual(
    expect.arrayContaining([
      'workflow_schedules_name_key',
      'workflow_attempts_child_attempt_key',
      'workflow_node_children_pkey',
      'workflow_node_children_run_fk',
      'workflow_node_children_node_fk',
      'workflow_node_children_child_run_fk',
      'workflow_node_children_current_attempt_fk',
      'workflow_commands_run_fk',
    ]),
  )
})

test('drizzle kit exports migration sql from app-owned schema file', async () => {
  const sql = await exportDrizzleMigrationSql()

  expect(sql).toContain('CREATE TYPE "workflow_run_kind"')
  expect(sql).toContain('CREATE TYPE "workflow_node_child_kind"')
  expect(sql).toContain('CREATE TABLE "workflow_runs"')
  expect(sql).toContain('CREATE TABLE "workflow_schedules"')
  expect(sql).toContain('CREATE TABLE "workflow_node_children"')
  expect(sql).toContain(
    'CONSTRAINT "workflow_node_children_pkey" PRIMARY KEY("run_id","node_name","child_key")',
  )
  expect(sql).toContain(
    'CONSTRAINT "workflow_attempts_child_attempt_key" UNIQUE("run_id","node_name","child_key","attempt_number")',
  )
  expect(sql).toContain('CREATE INDEX "workflow_node_children_node_idx"')
  expect(sql).toContain('CREATE INDEX "workflow_node_children_child_run_idx"')
  expect(sql).toContain('CREATE INDEX "workflow_schedules_due_idx"')
  expect(sql).toContain('"delivery_count" integer DEFAULT 0 NOT NULL')
  expect(sql).toContain('"dead_at" timestamp with time zone')
  expect(sql).toContain(
    'CREATE UNIQUE INDEX "workflow_commands_continue_dedup_idx"',
  )
  expect(sql).toContain(
    'CREATE INDEX "workflow_runs_parent_idx" ON "workflow_runs" ("parent_run_id") WHERE parent_run_id IS NOT NULL',
  )
  expect(sql).toContain(
    'CREATE INDEX "workflow_runs_prune_idx" ON "workflow_runs" ("status","updated_at") WHERE parent_run_id IS NULL',
  )
  expect(sql).toMatch(
    /CREATE INDEX "workflow_commands_claim_idx" ON "workflow_commands" \(.+\) WHERE dead_at IS NULL/,
  )
  expect(sql).toContain(
    'CREATE INDEX "workflow_commands_dead_idx" ON "workflow_commands" ("dead_at") WHERE dead_at IS NOT NULL',
  )
  // search GIN indexes are opt-in and absent from the default export
  expect(sql).not.toContain('workflow_runs_input_gin_idx')
  expect(sql).not.toContain('workflow_runs_tags_gin_idx')
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

test('drizzle schema includes search GIN indexes only on opt-in', () => {
  const runIndexNames = (schema: ReturnType<typeof createSchema>) =>
    getTableConfig(schema.tables.runs).indexes.map((index) => index.config.name)

  expect(runIndexNames(createSchema())).not.toEqual(
    expect.arrayContaining(['workflow_runs_input_gin_idx']),
  )
  expect(runIndexNames(createSchema({ searchIndexes: true }))).toEqual(
    expect.arrayContaining([
      'workflow_runs_input_gin_idx',
      'workflow_runs_tags_gin_idx',
    ]),
  )
})

test('status transitions are notify-only; watch yields run status changes', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)

  const runtime = createPostgresWorkflowRuntime({ connection })
  const run = await runtime.store.createRun({
    workflowName: 'run-events-notify-only',
    input: {},
  })
  await runtime.store.markRunRunning({ runId: run.id })
  // nothing persists per transition anymore — the table itself is gone
  const eventTables = await connection.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE tablename = 'workflow_run_events'",
  )
  expect(eventTables.rows).toStrictEqual([])

  const client = createWorkflowRuntimeClient(runtime)
  const iterator = client
    .watch(run.id, { pollIntervalMs: 25 })
    [Symbol.asyncIterator]()
  try {
    expect((await iterator.next()).value).toStrictEqual({
      kind: 'run',
      status: 'running',
    })
    await runtime.store.failRun({
      runId: run.id,
      error: new Error('boom'),
    })
    const terminal = (await iterator.next()).value
    expect(terminal?.kind).toBe('run')
    expect(terminal && 'status' in terminal ? terminal.status : undefined).toBe(
      'failed',
    )
    expect(
      terminal && 'error' in terminal ? terminal.error?.message : undefined,
    ).toBe('boom')
    expect((await iterator.next()).done).toBe(true)
  } finally {
    await iterator.return?.()
  }
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

test('postgres continue enqueue coalesces via partial-index upsert', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const run = await runtime.store.createRun({
    workflowName: 'postgres-coalesced-workflow',
    input: {},
  })
  const delayed = {
    kind: 'continueRun' as const,
    runId: run.id,
    workflowName: 'postgres-coalesced-workflow',
    generation: 1,
  }
  const immediate = {
    kind: 'continueRun' as const,
    runId: run.id,
    workflowName: 'postgres-coalesced-workflow',
    generation: 2,
  }

  await runtime.runCoordinationExecutor.enqueueDelayed(
    delayed,
    new Date(Date.now() + 60_000),
  )
  await runtime.runCoordinationExecutor.enqueue(immediate)

  const rows = await connection.query<{
    count: number
    payload: unknown
  }>(
    `
      SELECT count(*)::int AS count, max(payload::text)::jsonb AS payload
      FROM workflow_commands
      WHERE run_id = $1 AND kind = 'continue'
    `,
    [run.id],
  )
  expect(rows.rows[0]?.count).toBe(1)
  expect(rows.rows[0]?.payload).toStrictEqual(immediate)
  await expect(
    runtime.runCoordinationExecutor.claim({
      workerId: 'worker-1',
      workflowNames: ['postgres-coalesced-workflow'],
      leaseMs: 30_000,
    }),
  ).resolves.toMatchObject({ command: immediate })
})

test('postgres continue enqueue allows leased and fresh continue commands to coexist', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })
  const run = await runtime.store.createRun({
    workflowName: 'postgres-leased-continue-workflow',
    input: {},
  })
  const first = {
    kind: 'continueRun' as const,
    runId: run.id,
    workflowName: 'postgres-leased-continue-workflow',
    generation: 1,
  }
  const second = {
    kind: 'continueRun' as const,
    runId: run.id,
    workflowName: 'postgres-leased-continue-workflow',
    generation: 2,
  }

  await runtime.runCoordinationExecutor.enqueue(first)
  const leased = await runtime.runCoordinationExecutor.claim({
    workerId: 'worker-1',
    workflowNames: ['postgres-leased-continue-workflow'],
    leaseMs: 30_000,
  })
  await runtime.runCoordinationExecutor.enqueue(second)

  const counts = await connection.query<{
    total: number
    leased: number
    unclaimed: number
  }>(
    `
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE lease_token IS NOT NULL)::int AS leased,
        count(*) FILTER (WHERE lease_token IS NULL)::int AS unclaimed
      FROM workflow_commands
      WHERE run_id = $1 AND kind = 'continue'
    `,
    [run.id],
  )
  expect(counts.rows[0]).toStrictEqual({
    total: 2,
    leased: 1,
    unclaimed: 1,
  })

  const fresh = await runtime.runCoordinationExecutor.claim({
    workerId: 'worker-2',
    workflowNames: ['postgres-leased-continue-workflow'],
    leaseMs: 30_000,
  })
  expect(leased?.command).toStrictEqual(first)
  expect(fresh?.command).toStrictEqual(second)
})

test('postgres error releases record delivery metadata and cap exponential backoff', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({
    connection,
    maxDeliveries: 20,
  })
  const run = await runtime.store.createRun({
    workflowName: 'postgres-error-release-workflow',
    input: {},
  })
  const command = {
    kind: 'activityAttempt' as const,
    workflowName: 'postgres-error-release-workflow',
    activityName: 'content',
    runId: run.id,
    nodeName: 'content',
    childKey: '$self',
    attemptId: '00000000-0000-4000-8000-000000000214',
    leaseToken: 'attempt-lease',
    input: {},
  }
  await runtime.attemptExecutor.dispatchActivity(command)
  const claimed = await runtime.attemptExecutor.claim({
    taskNames: [],
    workerId: 'activity-worker-1',
    workflowNames: ['postgres-error-release-workflow'],
    activityNames: ['content'],
    leaseMs: 30_000,
  })

  await runtime.attemptExecutor.release(claimed!, {
    error: new Error('first poison'),
  })

  const firstRelease = await connection.query<{
    delivery_count: number
    last_error: { message: string }
    delay_ms: number
    dead_at: Date | null
  }>(
    `
      SELECT
        delivery_count,
        last_error,
        EXTRACT(EPOCH FROM (run_at - now())) * 1000 AS delay_ms,
        dead_at
      FROM workflow_commands
      WHERE attempt_id = $1
    `,
    [command.attemptId],
  )
  expect(firstRelease.rows[0]?.delivery_count).toBe(1)
  expect(firstRelease.rows[0]?.last_error).toMatchObject({
    message: 'first poison',
  })
  expect(Number(firstRelease.rows[0]?.delay_ms)).toBeGreaterThanOrEqual(50)
  expect(Number(firstRelease.rows[0]?.delay_ms)).toBeLessThan(500)
  expect(firstRelease.rows[0]?.dead_at).toBeNull()

  await connection.query(
    `
      UPDATE workflow_commands
      SET delivery_count = 12,
          lease_owner = 'activity-worker-2',
          lease_token = 'manual-lease',
          lease_expires_at = now() + interval '30 seconds'
      WHERE attempt_id = $1
    `,
    [command.attemptId],
  )
  await runtime.attemptExecutor.release(
    { ...claimed!, leaseToken: 'manual-lease' },
    { error: new Error('capped poison') },
  )

  const cappedRelease = await connection.query<{
    delivery_count: number
    delay_ms: number
  }>(
    `
      SELECT
        delivery_count,
        EXTRACT(EPOCH FROM (run_at - now())) * 1000 AS delay_ms
      FROM workflow_commands
      WHERE attempt_id = $1
    `,
    [command.attemptId],
  )
  expect(cappedRelease.rows[0]?.delivery_count).toBe(13)
  expect(Number(cappedRelease.rows[0]?.delay_ms)).toBeGreaterThan(250_000)
  expect(Number(cappedRelease.rows[0]?.delay_ms)).toBeLessThanOrEqual(300_500)
})

test('returns no activity claim for an empty activity filter', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const runtime = createPostgresWorkflowRuntime({ connection })

  await expect(
    runtime.attemptExecutor.claim({
      taskNames: [],
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
    childKey: '$self',
    attemptId: '00000000-0000-4000-8000-000000000002',
    leaseToken: 'attempt-lease',
    input: {},
  }

  await runtime.attemptExecutor.dispatchActivity(command)
  const claimed = await runtime.attemptExecutor.claim({
    taskNames: [],
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
    runtime.attemptExecutor.claim({
      taskNames: [],
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
    childKey: '$self',
    attemptId: '00000000-0000-4000-8000-000000000012',
    leaseToken: 'attempt-lease',
    input: {},
  }

  await runtime.attemptExecutor.dispatchActivity(command)
  const claimed = await runtime.attemptExecutor.claim({
    taskNames: [],
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
  await runtime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: node.name,
    children: [{ childKey: '$self', kind: 'activity' }],
  })
  const { attempt } = await runtime.store.ensureChildAttempt({
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
    input: { scenario: 'alpha' },
  })
  const childNode = await runtime.store.createNode({
    runId: run.id,
    name: 'child',
    kind: 'workflow',
  })
  await runtime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: childNode.name,
    children: [{ childKey: '$self', kind: 'workflow' }],
  })
  const child = await runtime.store.ensureChildRun({
    runId: run.id,
    nodeName: childNode.name,
    childKey: '$self',
    childKind: 'workflow',
    childName: 'snapshot-child',
    input: { child: true },
    rootRunId: run.rootRunId,
  })
  const mapNode = await runtime.store.createNode({
    runId: run.id,
    name: 'items',
    kind: 'mapTask',
  })
  const mapChildren = await runtime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: mapNode.name,
    children: [
      {
        childKey: 'item:0',
        kind: 'task',
        ordinal: 0,
        itemKey: 'one',
        item: { item: 'one' },
      },
    ],
  })

  const snapshot = await runtime.store.loadRunSnapshot(run.id)

  expect(snapshot?.run).toStrictEqual(run)
  expect(snapshot?.attempts).toStrictEqual([attempt])
  // children come back ordered by (node_name, ordinal, child_key)
  expect(snapshot?.children).toHaveLength(3)
  expect(snapshot?.children[0]).toStrictEqual(child.child)
  expect(snapshot?.children[1]).toMatchObject({
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
    kind: 'activity',
    status: 'running',
    currentAttemptId: attempt.id,
    attemptCount: 1,
    version: 2,
  })
  expect(snapshot?.children[1]?.createdAt).toBeInstanceOf(Date)
  expect(snapshot?.children[1]?.updatedAt).toBeInstanceOf(Date)
  expect(snapshot?.children[2]).toStrictEqual(mapChildren.children[0])
  expect(snapshot?.nodes).toHaveLength(3)
  expect(snapshot?.nodes[0]).toMatchObject({
    runId: node.runId,
    name: node.name,
    kind: node.kind,
    status: 'running',
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
  const statements: string[] = []
  const runtime = createPostgresWorkflowRuntime({
    connection: captureWorkflowStatements(connection, statements),
  })
  // warm up any lazy runtime initialization queries first
  await runtime.store.loadRunSnapshot(run.id)
  statements.length = 0

  const snapshot = await runtime.store.loadRunSnapshot(run.id)

  expect(snapshot?.run.id).toBe(run.id)
  expect(snapshot?.nodes).toStrictEqual([])
  expect(snapshot?.children).toStrictEqual([])
  expect(snapshot?.attempts).toStrictEqual([])
  // run, nodes, children, and attempts must come from a single statement so
  // concurrent writers cannot produce a torn snapshot
  expect(statements).toHaveLength(1)
  for (const table of [
    'workflow_runs',
    'workflow_nodes',
    'workflow_node_children',
    'workflow_attempts',
  ]) {
    expect(statements[0]).toContain(table)
  }
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

test('returns the existing child attempt after an insert race', async () => {
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
  await setupRuntime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: 'content',
    children: [{ childKey: '$self', kind: 'activity' }],
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: raceChildAttemptInsert(connection),
  })

  const result = await runtime.store.ensureChildAttempt({
    runId: run.id,
    nodeName: 'content',
    childKey: '$self',
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

test('returns the existing child run after a child run insert race', async () => {
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
  await setupRuntime.store.ensureNodeChildren({
    runId: parent.id,
    nodeName: 'child',
    children: [{ childKey: '$self', kind: 'workflow' }],
  })
  const childParams = {
    runId: parent.id,
    nodeName: 'child',
    childKey: '$self',
    childKind: 'workflow' as const,
    childName: 'racy-child-workflow',
    input: { scenario: 'alpha' },
    rootRunId: parent.rootRunId,
    idempotencyKey: ['racy-child-workflow', 'alpha'],
  }
  const runtime = createPostgresWorkflowRuntime({
    connection: raceChildRunAfterChildLoad(connection, childParams),
  })

  const result = await runtime.store.ensureChildRun(childParams)

  expect(result.created).toBe(false)
  expect(result.childRun.input).toStrictEqual({ scenario: 'alpha' })
  expect(result.child.childRunId).toBe(result.childRun.id)
  const runs = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_runs WHERE parent_run_id = $1',
    [parent.id],
  )
  expect(runs.rows[0]?.count).toBe(1)
})

test('returns existing node children after a child set insert race', async () => {
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
  const children = [
    {
      childKey: 'item:0',
      kind: 'task' as const,
      ordinal: 0,
      itemKey: 'alpha',
      item: { text: 'alpha' },
    },
    {
      childKey: 'item:1',
      kind: 'task' as const,
      ordinal: 1,
      itemKey: 'beta',
      item: { text: 'beta' },
    },
  ]
  const runtime = createPostgresWorkflowRuntime({
    connection: raceNodeChildrenAfterLoad(connection, {
      runId: run.id,
      nodeName: 'items',
      children,
    }),
  })

  const result = await runtime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: 'items',
    children,
  })

  expect(result.created).toBe(false)
  expect(result.children.map((child) => child.item)).toStrictEqual([
    { text: 'alpha' },
    { text: 'beta' },
  ])
  const rows = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_node_children',
  )
  expect(rows.rows[0]?.count).toBe(2)
})

test('rolls back child run creation when the child link update fails', async () => {
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
  await setupRuntime.store.ensureNodeChildren({
    runId: parent.id,
    nodeName: 'child',
    children: [{ childKey: '$self', kind: 'workflow' }],
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: failChildRunLinkUpdate(connection),
  })

  await expect(
    runtime.store.ensureChildRun({
      runId: parent.id,
      nodeName: 'child',
      childKey: '$self',
      childKind: 'workflow',
      childName: 'atomic-child-workflow',
      input: { scenario: 'alpha' },
      rootRunId: parent.rootRunId,
    }),
  ).rejects.toThrow('forced child run link failure')

  const runs = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_runs',
  )
  const children = await connection.query<{
    child_run_id: string | null
    status: string
  }>('SELECT child_run_id, status FROM workflow_node_children')
  expect(runs.rows[0]?.count).toBe(1)
  expect(children.rows).toStrictEqual([
    { child_run_id: null, status: 'pending' },
  ])
})

test('rolls back the whole child set when one child insert fails', async () => {
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
    connection: failNodeChildInsert(connection, 'item:1'),
  })

  await expect(
    runtime.store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'items',
      children: [
        {
          childKey: 'item:0',
          kind: 'task',
          ordinal: 0,
          item: { text: 'alpha' },
        },
        {
          childKey: 'item:1',
          kind: 'task',
          ordinal: 1,
          item: { text: 'beta' },
        },
      ],
    }),
  ).rejects.toThrow('forced node child insert failure')

  const children = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_node_children',
  )
  expect(children.rows[0]?.count).toBe(0)
})

test('rolls back createAttempt when the child update fails', async () => {
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
  await setupRuntime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: 'content',
    children: [{ childKey: '$self', kind: 'activity' }],
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: failChildUpdateAfterAttemptInsert(connection),
  })

  await expect(
    runtime.store.createAttempt({
      runId: run.id,
      nodeName: 'content',
      childKey: '$self',
      input: { text: 'alpha' },
    }),
  ).rejects.toThrow('forced child update failure')

  const attempts = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_attempts',
  )
  const children = await connection.query<{
    status: string
    current_attempt_id: string | null
    attempt_count: number
  }>(
    'SELECT status, current_attempt_id, attempt_count FROM workflow_node_children',
  )
  expect(attempts.rows[0]?.count).toBe(0)
  expect(children.rows[0]).toStrictEqual({
    status: 'pending',
    current_attempt_id: null,
    attempt_count: 0,
  })
})

test('rolls back ensureChildAttempt when the child update fails', async () => {
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
  await setupRuntime.store.ensureNodeChildren({
    runId: run.id,
    nodeName: 'content',
    children: [{ childKey: '$self', kind: 'activity' }],
  })
  const runtime = createPostgresWorkflowRuntime({
    connection: failChildUpdateAfterAttemptInsert(connection),
  })

  await expect(
    runtime.store.ensureChildAttempt({
      runId: run.id,
      nodeName: 'content',
      childKey: '$self',
      input: { text: 'alpha' },
    }),
  ).rejects.toThrow('forced child update failure')

  const attempts = await connection.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workflow_attempts',
  )
  const children = await connection.query<{
    status: string
    current_attempt_id: string | null
    attempt_count: number
  }>(
    'SELECT status, current_attempt_id, attempt_count FROM workflow_node_children',
  )
  expect(attempts.rows[0]?.count).toBe(0)
  expect(children.rows[0]).toStrictEqual({
    status: 'pending',
    current_attempt_id: null,
    attempt_count: 0,
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

test('worker retention pruning takes the Postgres advisory transaction lock', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  const statements: string[] = []
  const runtime = createPostgresWorkflowRuntime({
    connection: captureRetentionLockQueries(connection, statements),
  })
  const run = await runtime.store.createRun({
    workflowName: 'advisory-retention-workflow',
    input: {},
  })
  await runtime.store.completeRun({ runId: run.id, output: { ok: true } })
  await new Promise((resolve) => setTimeout(resolve, 5))
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')
  const container = new Container({ logger })

  await runWorkflowWorker({
    ...runtime,
    container,
    workflows: [],
    workerId: 'postgres-retention-worker',
    retention: {
      olderThan: '0ms',
      batchSize: 1,
    },
  })

  expect(
    statements.some((sql) =>
      /pg_try_advisory_xact_lock\s*\(\s*hashtext\('workflow_prune'\)\s*\)/i.test(
        sql,
      ),
    ),
  ).toBe(true)
  expect(
    statements.some(
      (sql) =>
        /DELETE\s+FROM\s+workflow_runs/i.test(sql) &&
        /FOR UPDATE SKIP LOCKED/i.test(sql),
    ),
  ).toBe(true)
  await expect(runtime.store.loadRunSnapshot(run.id)).resolves.toBeUndefined()
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
      'workflow_attempts_node_fk',
      'workflow_attempts_child_attempt_key',
      'workflow_node_children_run_fk',
      'workflow_node_children_node_fk',
      'workflow_node_children_child_run_fk',
      'workflow_node_children_current_attempt_fk',
      'workflow_run_leases_run_fk',
      'workflow_commands_run_fk',
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

  // search GIN indexes are optional: dropping them keeps the schema valid
  await connection.query('DROP INDEX workflow_runs_tags_gin_idx')
  await connection.query('DROP INDEX workflow_runs_input_gin_idx')
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query('DROP INDEX workflow_runs_root_idx')

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_runs_root_idx',
  )
})

test('verifies optional postgres schema indexes when present', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)

  await connection.query('DROP INDEX workflow_runs_tags_gin_idx')
  await connection.query(
    'CREATE INDEX workflow_runs_tags_gin_idx ON workflow_runs (created_at)',
  )

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Invalid workflow Postgres schema indexes: workflow_runs_tags_gin_idx',
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

test('verifies postgres schema partial index predicates', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query(
    'DROP INDEX IF EXISTS workflow_commands_continue_dedup_idx',
  )
  await connection.query(`
    CREATE UNIQUE INDEX workflow_commands_continue_dedup_idx
    ON workflow_commands (run_id)
  `)

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Invalid workflow Postgres schema indexes: workflow_commands_continue_dedup_idx',
  )
})

test('rejects a v2 workflow postgres schema missing v3 command columns and indexes', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await connection.query(
    'DROP INDEX IF EXISTS workflow_commands_continue_dedup_idx',
  )
  await connection.query('DROP INDEX IF EXISTS workflow_runs_parent_idx')
  await connection.query('DROP INDEX IF EXISTS workflow_runs_root_idx')
  await connection.query(
    'ALTER TABLE workflow_commands DROP COLUMN IF EXISTS delivery_count',
  )
  await connection.query(
    'ALTER TABLE workflow_commands DROP COLUMN IF EXISTS last_error',
  )
  await connection.query(
    'ALTER TABLE workflow_commands DROP COLUMN IF EXISTS dead_at',
  )
  await connection.query(
    `
      UPDATE workflow_schema_version
      SET version = 2
      WHERE id = 1
    `,
  )

  // dropping dead_at also cascades away the partial claim/dead indexes
  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_runs_parent_idx, workflow_runs_root_idx, workflow_commands_claim_idx, workflow_commands_dead_idx, workflow_commands_continue_dedup_idx',
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

test('verifies postgres schema child attempt uniqueness constraints', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query(
    'ALTER TABLE workflow_attempts DROP CONSTRAINT workflow_attempts_child_attempt_key',
  )

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_attempts_child_attempt_key',
  )

  await installPostgresWorkflowSchemaForTesting(connection)
  await connection.query(
    'ALTER TABLE workflow_node_children DROP CONSTRAINT workflow_node_children_current_attempt_fk',
  )

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Missing workflow Postgres schema objects: workflow_node_children_current_attempt_fk',
  )
})

test('verifies postgres schema constraint definitions', async () => {
  const connection = createPgliteConnection()
  await installPostgresWorkflowSchemaForTesting(connection)
  await expect(
    verifyPostgresWorkflowSchema(connection),
  ).resolves.toBeUndefined()

  await connection.query(
    'ALTER TABLE workflow_attempts DROP CONSTRAINT workflow_attempts_child_attempt_key',
  )
  await connection.query(`
    ALTER TABLE workflow_attempts
    ADD CONSTRAINT workflow_attempts_child_attempt_key
    CHECK (child_key IS NOT NULL)
  `)

  await expect(verifyPostgresWorkflowSchema(connection)).rejects.toThrow(
    'Invalid workflow Postgres schema constraints: workflow_attempts_child_attempt_key',
  )
})
