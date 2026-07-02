import { randomUUID } from 'node:crypto'

import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../runtime/commands.ts'
import type {
  AttemptExecutor,
  RunCoordinationExecutor,
} from '../runtime/executors.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/index.ts'
import type {
  CreateRunInput,
  ListRunsFilter,
  WorkflowStore,
} from '../runtime/store.ts'
import type { WorkflowRuntimeAtomicStart } from '../runtime/coordinator.ts'
import type {
  WorkflowRuntimeAtomicCompletion,
  WorkflowRuntimeAtomicContinuation,
} from '../runtime/worker.ts'
import type {
  NodeChildIdentity,
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredError,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from '../runtime/state.ts'
import {
  isTerminalNodeStatus,
  isTerminalRunStatus,
} from '../runtime/status.ts'

export type WorkflowPostgresConnection = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[] }>
  transaction<T>(
    handler: (connection: WorkflowPostgresConnection) => Promise<T>,
  ): Promise<T>
}

type PostgresWorkflowRuntime = WorkflowRuntimeAdapter & {
  readonly connection: WorkflowPostgresConnection
}

type JsonRecord = Record<string, unknown>

export const WORKFLOW_POSTGRES_SCHEMA_VERSION = 1
const TASK_RUN_NODE_NAME = '$task'

export const WORKFLOW_POSTGRES_SCHEMA_MANIFEST = {
  version: WORKFLOW_POSTGRES_SCHEMA_VERSION,
  enums: [
    'workflow_run_kind',
    'workflow_node_kind',
    'workflow_run_status',
    'workflow_node_status',
    'workflow_attempt_status',
    'workflow_command_kind',
  ],
  enumValues: {
    workflow_run_kind: ['workflow', 'task'],
    workflow_node_kind: [
      'activity',
      'task',
      'workflow',
      'branch',
      'parallel',
      'mapTask',
      'mapWorkflow',
    ],
    workflow_run_status: [
      'queued',
      'running',
      'waiting',
      'cancelling',
      'cancelled',
      'failed',
      'completed',
    ],
    workflow_node_status: [
      'pending',
      'running',
      'waiting',
      'cancelling',
      'cancelled',
      'failed',
      'completed',
    ],
    workflow_attempt_status: [
      'started',
      'completed',
      'failed',
      'timedOut',
      'cancelled',
    ],
    workflow_command_kind: ['continue', 'activity', 'task'],
  },
  tables: [
    'workflow_schema_version',
    'workflow_runs',
    'workflow_nodes',
    'workflow_attempts',
    'workflow_child_links',
    'workflow_map_item_sets',
    'workflow_map_items',
    'workflow_run_leases',
    'workflow_commands',
  ],
  constraints: [
    'workflow_schema_version_pkey',
    'workflow_schema_version_singleton_chk',
    'workflow_runs_pkey',
    'workflow_nodes_pkey',
    'workflow_attempts_pkey',
    'workflow_attempts_identity_key_key',
    'workflow_child_links_pkey',
    'workflow_map_item_sets_pkey',
    'workflow_map_items_pkey',
    'workflow_map_items_identity_key_key',
    'workflow_run_leases_pkey',
    'workflow_commands_pkey',
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
  ],
  indexes: [
    'workflow_runs_idempotency_idx',
    'workflow_runs_input_gin_idx',
    'workflow_runs_tags_gin_idx',
    'workflow_commands_claim_idx',
  ],
  columns: {
    workflow_schema_version: {
      id: { type: 'int4', nullable: false },
      version: { type: 'int4', nullable: false },
      installed_at: { type: 'timestamptz', nullable: false },
    },
    workflow_runs: {
      id: { type: 'uuid', nullable: false },
      kind: { type: 'workflow_run_kind', nullable: false },
      name: { type: 'text', nullable: false },
      workflow_name: { type: 'text', nullable: false },
      task_name: { type: 'text', nullable: true },
      status: { type: 'workflow_run_status', nullable: false },
      input: { type: 'jsonb', nullable: false },
      output: { type: 'jsonb', nullable: true },
      error: { type: 'jsonb', nullable: true },
      parent_run_id: { type: 'uuid', nullable: true },
      parent_node_name: { type: 'text', nullable: true },
      root_run_id: { type: 'uuid', nullable: false },
      tags: { type: 'jsonb', nullable: false },
      idempotency_key: { type: 'jsonb', nullable: true },
      version: { type: 'int4', nullable: false },
      created_at: { type: 'timestamptz', nullable: false },
      updated_at: { type: 'timestamptz', nullable: false },
    },
    workflow_nodes: {
      run_id: { type: 'uuid', nullable: false },
      name: { type: 'text', nullable: false },
      kind: { type: 'workflow_node_kind', nullable: false },
      status: { type: 'workflow_node_status', nullable: false },
      input: { type: 'jsonb', nullable: true },
      output: { type: 'jsonb', nullable: true },
      error: { type: 'jsonb', nullable: true },
      selected_case: { type: 'text', nullable: true },
      current_attempt_id: { type: 'uuid', nullable: true },
      next_attempt_at: { type: 'timestamptz', nullable: true },
      attempt_count: { type: 'int4', nullable: false },
      version: { type: 'int4', nullable: false },
      created_at: { type: 'timestamptz', nullable: false },
      updated_at: { type: 'timestamptz', nullable: false },
    },
    workflow_attempts: {
      id: { type: 'uuid', nullable: false },
      run_id: { type: 'uuid', nullable: false },
      node_name: { type: 'text', nullable: false },
      identity_key: { type: 'text', nullable: true },
      identity: { type: 'jsonb', nullable: true },
      status: { type: 'workflow_attempt_status', nullable: false },
      worker_id: { type: 'text', nullable: true },
      lease_token: { type: 'text', nullable: true },
      attempt_number: { type: 'int4', nullable: false },
      input: { type: 'jsonb', nullable: false },
      idempotency_key: { type: 'jsonb', nullable: true },
      output: { type: 'jsonb', nullable: true },
      error: { type: 'jsonb', nullable: true },
      dispatched_at: { type: 'timestamptz', nullable: false },
      heartbeat_at: { type: 'timestamptz', nullable: true },
      completed_at: { type: 'timestamptz', nullable: true },
    },
    workflow_child_links: {
      identity_key: { type: 'text', nullable: false },
      identity: { type: 'jsonb', nullable: false },
      parent_run_id: { type: 'uuid', nullable: false },
      parent_node_name: { type: 'text', nullable: false },
      child_run_id: { type: 'uuid', nullable: false },
      child_kind: { type: 'workflow_run_kind', nullable: false },
      child_name: { type: 'text', nullable: false },
      workflow_name: { type: 'text', nullable: false },
      task_name: { type: 'text', nullable: true },
      case_key: { type: 'text', nullable: true },
      member_key: { type: 'text', nullable: true },
      item_index: { type: 'int4', nullable: true },
      item_key: { type: 'text', nullable: true },
    },
    workflow_map_item_sets: {
      run_id: { type: 'uuid', nullable: false },
      node_name: { type: 'text', nullable: false },
      keys: { type: 'jsonb', nullable: false },
    },
    workflow_map_items: {
      run_id: { type: 'uuid', nullable: false },
      node_name: { type: 'text', nullable: false },
      item_index: { type: 'int4', nullable: false },
      identity_key: { type: 'text', nullable: false },
      identity: { type: 'jsonb', nullable: false },
      item_key: { type: 'text', nullable: true },
      item: { type: 'jsonb', nullable: false },
      status: { type: 'workflow_node_status', nullable: false },
      output: { type: 'jsonb', nullable: true },
      error: { type: 'jsonb', nullable: true },
      child_run_id: { type: 'uuid', nullable: true },
      attempt_id: { type: 'uuid', nullable: true },
    },
    workflow_run_leases: {
      run_id: { type: 'uuid', nullable: false },
      lease_token: { type: 'text', nullable: false },
      version: { type: 'int4', nullable: false },
      expires_at: { type: 'timestamptz', nullable: false },
    },
    workflow_commands: {
      id: { type: 'uuid', nullable: false },
      kind: { type: 'workflow_command_kind', nullable: false },
      run_id: { type: 'uuid', nullable: false },
      workflow_name: { type: 'text', nullable: true },
      task_name: { type: 'text', nullable: true },
      activity_name: { type: 'text', nullable: true },
      node_name: { type: 'text', nullable: true },
      attempt_id: { type: 'uuid', nullable: true },
      payload: { type: 'jsonb', nullable: false },
      run_at: { type: 'timestamptz', nullable: false },
      priority: { type: 'int4', nullable: false },
      lease_owner: { type: 'text', nullable: true },
      lease_token: { type: 'text', nullable: true },
      lease_expires_at: { type: 'timestamptz', nullable: true },
      created_at: { type: 'timestamptz', nullable: false },
    },
  },
} as const

const id = () => randomUUID()
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const isUuid = (value: string) => uuidPattern.test(value)
let lastTimestamp = 0
const now = () => {
  const current = Date.now()
  lastTimestamp = Math.max(current, lastTimestamp + 1)
  return new Date(lastTimestamp)
}
const json = (value: unknown) => JSON.stringify(value)
const fromOptional = (value: unknown) => (value === null ? undefined : value)
const sameValue = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)
const sameOptionalValue = (left: unknown, right: unknown) =>
  left === undefined && right === undefined
    ? true
    : left !== undefined && right !== undefined && sameValue(left, right)

const identityKey = (identity: NodeChildIdentity) =>
  JSON.stringify([
    identity.runId,
    identity.nodeName,
    identity.caseKey ?? null,
    identity.memberKey ?? null,
    identity.itemIndex ?? null,
    identity.itemKey ?? null,
  ])

const storedError = (error: unknown): StoredError => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    }
  }

  return { message: String(error) }
}

const optional = <K extends string, V>(key: K, value: V | null | undefined) =>
  value === undefined || value === null
    ? ({} as Partial<Record<K, V>>)
    : ({ [key]: value } as Record<K, V>)

const runnableName = (input: CreateRunInput) =>
  input.name ?? input.taskName ?? input.workflowName

const mapRun = (row: JsonRecord): StoredRun => ({
  id: row.id as string,
  kind: row.kind as StoredRun['kind'],
  name: row.name as string,
  workflowName: row.workflow_name as string,
  ...optional('taskName', row.task_name as string | undefined),
  status: row.status as StoredRun['status'],
  input: row.input,
  ...optional('output', fromOptional(row.output)),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  ...optional('parentRunId', row.parent_run_id as string | undefined),
  ...optional('parentNodeName', row.parent_node_name as string | undefined),
  rootRunId: row.root_run_id as string,
  tags: (row.tags ?? {}) as Record<string, string>,
  ...optional(
    'idempotencyKey',
    fromOptional(row.idempotency_key) as readonly unknown[] | undefined,
  ),
  version: row.version as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

const mapNode = (row: JsonRecord): StoredNode => ({
  runId: row.run_id as string,
  name: row.name as string,
  kind: row.kind as StoredNode['kind'],
  status: row.status as StoredNode['status'],
  ...optional('input', fromOptional(row.input)),
  ...optional('output', fromOptional(row.output)),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  ...optional('selectedCase', row.selected_case as string | undefined),
  ...optional('currentAttemptId', row.current_attempt_id as string | undefined),
  ...optional('nextAttemptAt', row.next_attempt_at as Date | undefined),
  attemptCount: row.attempt_count as number,
  version: row.version as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

const mapAttempt = (row: JsonRecord): StoredAttempt => ({
  id: row.id as string,
  runId: row.run_id as string,
  nodeName: row.node_name as string,
  ...optional(
    'identity',
    fromOptional(row.identity) as NodeChildIdentity | undefined,
  ),
  status: row.status as StoredAttempt['status'],
  ...optional('workerId', row.worker_id as string | undefined),
  ...optional('leaseToken', row.lease_token as string | undefined),
  attemptNumber: row.attempt_number as number,
  input: row.input,
  ...optional(
    'idempotencyKey',
    fromOptional(row.idempotency_key) as readonly unknown[] | undefined,
  ),
  ...optional('output', fromOptional(row.output)),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  dispatchedAt: row.dispatched_at as Date,
  ...optional('heartbeatAt', row.heartbeat_at as Date | undefined),
  ...optional('completedAt', row.completed_at as Date | undefined),
})

const mapChildLink = (row: JsonRecord): StoredChildLink => ({
  identity: row.identity as NodeChildIdentity,
  parentRunId: row.parent_run_id as string,
  parentNodeName: row.parent_node_name as string,
  childRunId: row.child_run_id as string,
  childKind: row.child_kind as StoredChildLink['childKind'],
  childName: row.child_name as string,
  workflowName: row.workflow_name as string,
  ...optional('taskName', row.task_name as string | undefined),
  ...optional('caseKey', row.case_key as string | undefined),
  ...optional('memberKey', row.member_key as string | undefined),
  ...optional('itemIndex', row.item_index as number | undefined),
  ...optional('itemKey', row.item_key as string | undefined),
})

const mapMapItem = (row: JsonRecord): StoredMapItem => ({
  identity: row.identity as NodeChildIdentity,
  runId: row.run_id as string,
  nodeName: row.node_name as string,
  index: row.item_index as number,
  ...optional('key', row.item_key as string | undefined),
  item: row.item,
  status: row.status as StoredMapItem['status'],
  ...optional('output', fromOptional(row.output)),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  ...optional('childRunId', row.child_run_id as string | undefined),
  ...optional('attemptId', row.attempt_id as string | undefined),
})

const one = async <T extends JsonRecord>(
  db: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) => {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

const many = async <T extends JsonRecord>(
  db: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) => (await db.query<T>(sql, params)).rows

export async function verifyPostgresWorkflowSchema(
  db: WorkflowPostgresConnection,
) {
  const expectedColumns = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.columns,
  ).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, definition]) => ({
      key: `${table}.${column}`,
      table,
      column,
      type: definition.type,
      nullable: definition.nullable,
    })),
  )
  const [enums, enumLabels, tables, columns, constraints, indexes] =
    await Promise.all([
      many(
        db,
        `
          SELECT t.typname AS name
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = current_schema()
            AND t.typname = ANY($1)
        `,
        [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enums]],
      ),
      many<{
        enum_name: string
        enum_label: string
      }>(
        db,
        `
          SELECT t.typname AS enum_name, e.enumlabel AS enum_label
          FROM pg_type t
          JOIN pg_namespace n ON n.oid = t.typnamespace
          JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE n.nspname = current_schema()
            AND t.typname = ANY($1)
          ORDER BY t.typname, e.enumsortorder
        `,
        [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enums]],
      ),
      many(
        db,
        `
          SELECT tablename AS name
          FROM pg_tables
          WHERE schemaname = current_schema()
            AND tablename = ANY($1)
        `,
        [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.tables]],
      ),
      many<{
        table_name: string
        column_name: string
        udt_name: string
        is_nullable: string
      }>(
        db,
        `
          SELECT table_name, column_name, udt_name, is_nullable
          FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = ANY($1)
        `,
        [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.tables]],
      ),
      many(
        db,
        `
          SELECT c.conname AS name
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          WHERE n.nspname = current_schema()
            AND c.conname = ANY($1)
        `,
        [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraints]],
      ),
      many(
        db,
        `
          SELECT indexname AS name
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND indexname = ANY($1)
        `,
        [[...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexes]],
      ),
    ])

  const existing = new Set([
    ...enums.map((row) => row.name),
    ...tables.map((row) => row.name),
    ...constraints.map((row) => row.name),
    ...indexes.map((row) => row.name),
  ])
  const missing = [
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enums,
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.tables,
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraints,
    ...WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexes,
  ].filter((name) => !existing.has(name))

  if (missing.length > 0) {
    throw new Error(
      `Missing workflow Postgres schema objects: ${missing.join(', ')}`,
    )
  }

  const labelsByEnum = new Map<string, string[]>()
  for (const row of enumLabels) {
    const values = labelsByEnum.get(row.enum_name) ?? []
    values.push(row.enum_label)
    labelsByEnum.set(row.enum_name, values)
  }
  const invalidEnums = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.enumValues,
  )
    .filter(([name, values]) =>
      JSON.stringify(labelsByEnum.get(name) ?? []) !== JSON.stringify(values),
    )
    .map(([name]) => name)

  if (invalidEnums.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema enums: ${invalidEnums.join(', ')}`,
    )
  }

  const columnsByKey = new Map(
    columns.map((column) => [
      `${column.table_name}.${column.column_name}`,
      column,
    ]),
  )
  const invalidColumns = expectedColumns
    .filter((expected) => {
      const column = columnsByKey.get(expected.key)
      return (
        !column ||
        column.udt_name !== expected.type ||
        (column.is_nullable === 'YES') !== expected.nullable
      )
    })
    .map((expected) => expected.key)

  if (invalidColumns.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema columns: ${invalidColumns.join(', ')}`,
    )
  }

  const versionRow = await one<{
    id: number
    version: number
  }>(
    db,
    `
      SELECT id, version
      FROM workflow_schema_version
      WHERE id = 1
    `,
  )

  if (!versionRow) {
    throw new Error('Missing workflow Postgres schema version')
  }
  if (versionRow.version !== WORKFLOW_POSTGRES_SCHEMA_MANIFEST.version) {
    throw new Error(
      `Unsupported workflow Postgres schema version [${versionRow.version}], expected [${WORKFLOW_POSTGRES_SCHEMA_MANIFEST.version}]`,
    )
  }
}

export async function installPostgresWorkflowSchemaForTesting(
  db: WorkflowPostgresConnection,
) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_schema_version (
      id integer PRIMARY KEY DEFAULT 1,
      version integer NOT NULL,
      installed_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workflow_schema_version_singleton_chk CHECK (id = 1)
    )
  `)
  await db.query(
    `
      INSERT INTO workflow_schema_version (id, version)
      VALUES (1, $1)
      ON CONFLICT (id) DO NOTHING
    `,
    [WORKFLOW_POSTGRES_SCHEMA_MANIFEST.version],
  )
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_kind') THEN
        CREATE TYPE workflow_run_kind AS ENUM ('workflow', 'task');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_kind') THEN
        CREATE TYPE workflow_node_kind AS ENUM (
          'activity',
          'task',
          'workflow',
          'branch',
          'parallel',
          'mapTask',
          'mapWorkflow'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_run_status') THEN
        CREATE TYPE workflow_run_status AS ENUM (
          'queued',
          'running',
          'waiting',
          'cancelling',
          'cancelled',
          'failed',
          'completed'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_node_status') THEN
        CREATE TYPE workflow_node_status AS ENUM (
          'pending',
          'running',
          'waiting',
          'cancelling',
          'cancelled',
          'failed',
          'completed'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_attempt_status') THEN
        CREATE TYPE workflow_attempt_status AS ENUM (
          'started',
          'completed',
          'failed',
          'timedOut',
          'cancelled'
        );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'workflow_command_kind') THEN
        CREATE TYPE workflow_command_kind AS ENUM (
          'continue',
          'activity',
          'task'
        );
      END IF;
    END
    $$;
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id uuid PRIMARY KEY,
      kind workflow_run_kind NOT NULL,
      name text NOT NULL,
      workflow_name text NOT NULL,
      task_name text,
      status workflow_run_status NOT NULL,
      input jsonb NOT NULL,
      output jsonb,
      error jsonb,
      parent_run_id uuid,
      parent_node_name text,
      root_run_id uuid NOT NULL,
      tags jsonb NOT NULL DEFAULT '{}'::jsonb,
      idempotency_key jsonb,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `)
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_idempotency_idx
    ON workflow_runs (idempotency_key)
    WHERE idempotency_key IS NOT NULL
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_runs_input_gin_idx
    ON workflow_runs USING gin (input jsonb_path_ops)
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_runs_tags_gin_idx
    ON workflow_runs USING gin (tags jsonb_path_ops)
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_nodes (
      run_id uuid NOT NULL,
      name text NOT NULL,
      kind workflow_node_kind NOT NULL,
      status workflow_node_status NOT NULL,
      input jsonb,
      output jsonb,
      error jsonb,
      selected_case text,
      current_attempt_id uuid,
      next_attempt_at timestamptz,
      attempt_count integer NOT NULL,
      version integer NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (run_id, name)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_attempts (
      id uuid PRIMARY KEY,
      run_id uuid NOT NULL,
      node_name text NOT NULL,
      identity_key text,
      identity jsonb,
      status workflow_attempt_status NOT NULL,
      worker_id text,
      lease_token text,
      attempt_number integer NOT NULL,
      input jsonb NOT NULL,
      idempotency_key jsonb,
      output jsonb,
      error jsonb,
      dispatched_at timestamptz NOT NULL,
      heartbeat_at timestamptz,
      completed_at timestamptz,
      CONSTRAINT workflow_attempts_identity_key_key UNIQUE (identity_key)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_child_links (
      identity_key text PRIMARY KEY,
      identity jsonb NOT NULL,
      parent_run_id uuid NOT NULL,
      parent_node_name text NOT NULL,
      child_run_id uuid NOT NULL,
      child_kind workflow_run_kind NOT NULL,
      child_name text NOT NULL,
      workflow_name text NOT NULL,
      task_name text,
      case_key text,
      member_key text,
      item_index integer,
      item_key text
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_map_item_sets (
      run_id uuid NOT NULL,
      node_name text NOT NULL,
      keys jsonb NOT NULL,
      PRIMARY KEY (run_id, node_name)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_map_items (
      run_id uuid NOT NULL,
      node_name text NOT NULL,
      item_index integer NOT NULL,
      identity_key text NOT NULL,
      identity jsonb NOT NULL,
      item_key text,
      item jsonb NOT NULL,
      status workflow_node_status NOT NULL,
      output jsonb,
      error jsonb,
      child_run_id uuid,
      attempt_id uuid,
      CONSTRAINT workflow_map_items_identity_key_key UNIQUE (identity_key),
      PRIMARY KEY (run_id, node_name, item_index)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_run_leases (
      run_id uuid PRIMARY KEY,
      lease_token text NOT NULL,
      version integer NOT NULL,
      expires_at timestamptz NOT NULL
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS workflow_commands (
      id uuid PRIMARY KEY,
      kind workflow_command_kind NOT NULL,
      run_id uuid NOT NULL,
      workflow_name text,
      task_name text,
      activity_name text,
      node_name text,
      attempt_id uuid,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      run_at timestamptz NOT NULL DEFAULT now(),
      priority integer NOT NULL DEFAULT 0,
      lease_owner text,
      lease_token text,
      lease_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await db.query(`
    CREATE INDEX IF NOT EXISTS workflow_commands_claim_idx
    ON workflow_commands (kind, lease_token, run_at, priority)
  `)
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_parent_run_fk') THEN
        ALTER TABLE workflow_runs
        ADD CONSTRAINT workflow_runs_parent_run_fk
        FOREIGN KEY (parent_run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_root_run_fk') THEN
        ALTER TABLE workflow_runs
        ADD CONSTRAINT workflow_runs_root_run_fk
        FOREIGN KEY (root_run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_runs_parent_node_fk') THEN
        ALTER TABLE workflow_runs
        ADD CONSTRAINT workflow_runs_parent_node_fk
        FOREIGN KEY (parent_run_id, parent_node_name)
        REFERENCES workflow_nodes(run_id, name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_nodes_run_fk') THEN
        ALTER TABLE workflow_nodes
        ADD CONSTRAINT workflow_nodes_run_fk
        FOREIGN KEY (run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_nodes_current_attempt_fk') THEN
        ALTER TABLE workflow_nodes
        ADD CONSTRAINT workflow_nodes_current_attempt_fk
        FOREIGN KEY (current_attempt_id)
        REFERENCES workflow_attempts(id)
        ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_attempts_node_fk') THEN
        ALTER TABLE workflow_attempts
        ADD CONSTRAINT workflow_attempts_node_fk
        FOREIGN KEY (run_id, node_name)
        REFERENCES workflow_nodes(run_id, name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_attempts_identity_key_key') THEN
        ALTER TABLE workflow_attempts
        ADD CONSTRAINT workflow_attempts_identity_key_key
        UNIQUE (identity_key);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_child_links_parent_node_fk') THEN
        ALTER TABLE workflow_child_links
        ADD CONSTRAINT workflow_child_links_parent_node_fk
        FOREIGN KEY (parent_run_id, parent_node_name)
        REFERENCES workflow_nodes(run_id, name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_child_links_child_run_fk') THEN
        ALTER TABLE workflow_child_links
        ADD CONSTRAINT workflow_child_links_child_run_fk
        FOREIGN KEY (child_run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_map_item_sets_node_fk') THEN
        ALTER TABLE workflow_map_item_sets
        ADD CONSTRAINT workflow_map_item_sets_node_fk
        FOREIGN KEY (run_id, node_name)
        REFERENCES workflow_nodes(run_id, name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_map_items_set_fk') THEN
        ALTER TABLE workflow_map_items
        ADD CONSTRAINT workflow_map_items_set_fk
        FOREIGN KEY (run_id, node_name)
        REFERENCES workflow_map_item_sets(run_id, node_name)
        ON DELETE CASCADE;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_map_items_child_run_fk') THEN
        ALTER TABLE workflow_map_items
        ADD CONSTRAINT workflow_map_items_child_run_fk
        FOREIGN KEY (child_run_id)
        REFERENCES workflow_runs(id)
        ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_map_items_attempt_fk') THEN
        ALTER TABLE workflow_map_items
        ADD CONSTRAINT workflow_map_items_attempt_fk
        FOREIGN KEY (attempt_id)
        REFERENCES workflow_attempts(id)
        ON DELETE SET NULL;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_map_items_identity_key_key') THEN
        ALTER TABLE workflow_map_items
        ADD CONSTRAINT workflow_map_items_identity_key_key
        UNIQUE (identity_key);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_run_leases_run_fk') THEN
        ALTER TABLE workflow_run_leases
        ADD CONSTRAINT workflow_run_leases_run_fk
        FOREIGN KEY (run_id)
        REFERENCES workflow_runs(id)
        ON DELETE CASCADE;
      END IF;
    END
    $$;
  `)
}

export function createPostgresWorkflowRuntime(params: {
  readonly connection: WorkflowPostgresConnection
}): PostgresWorkflowRuntime {
  const db = params.connection
  const ready = Promise.resolve()

  const store: WorkflowStore = {
    async createRun(input) {
      await ready
      if (input.idempotencyKey) {
        const existing = await one(
          db,
          'SELECT * FROM workflow_runs WHERE idempotency_key = $1::jsonb',
          [json(input.idempotencyKey)],
        )
        if (existing) {
          const run = mapRun(existing)
          if (
            run.kind === (input.kind ?? 'workflow') &&
            run.name === runnableName(input) &&
            run.workflowName === input.workflowName &&
            run.taskName === input.taskName &&
            run.parentRunId === input.parentRunId &&
            run.parentNodeName === input.parentNodeName &&
            run.rootRunId === (input.rootRunId ?? run.id) &&
            sameValue(run.input, input.input)
          ) {
            return run
          }
          throw new Error(`Conflicting idempotent run [${input.workflowName}]`)
        }
      }

      const date = now()
      const runId = id()
      const row = await one(
        db,
        `
          INSERT INTO workflow_runs (
            id, kind, name, workflow_name, task_name, status, input,
            parent_run_id, parent_node_name, root_run_id, tags,
            idempotency_key, version, created_at, updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, 'queued', $6::jsonb,
            $7, $8, $9, $10::jsonb, $11::jsonb, 1, $12, $12
          )
          RETURNING *
        `,
        [
          runId,
          input.kind ?? 'workflow',
          runnableName(input),
          input.workflowName,
          input.taskName ?? null,
          json(input.input),
          input.parentRunId ?? null,
          input.parentNodeName ?? null,
          input.rootRunId ?? runId,
          json(input.tags ?? {}),
          input.idempotencyKey ? json(input.idempotencyKey) : null,
          date,
        ],
      )
      return mapRun(row!)
    },
    async listRuns(filter: ListRunsFilter = {}) {
      await ready
      if (
        filter.limit !== undefined &&
        (!Number.isFinite(filter.limit) || filter.limit < 1)
      ) {
        return { runs: [] }
      }

      const params: unknown[] = []
      const where: string[] = []
      const push = (value: unknown) => {
        params.push(value)
        return `$${params.length}`
      }

      if (filter.kind !== undefined) where.push(`kind = ${push(filter.kind)}`)
      if (filter.name !== undefined) where.push(`name = ${push(filter.name)}`)
      if (filter.status !== undefined) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status]
        where.push(
          `status IN (${statuses.map((status) => push(status)).join(', ')})`,
        )
      }
      if (filter.parentRunId !== undefined) {
        if (!isUuid(filter.parentRunId)) return { runs: [] }
        where.push(`parent_run_id = ${push(filter.parentRunId)}`)
      }
      if (filter.rootRunId !== undefined) {
        if (!isUuid(filter.rootRunId)) return { runs: [] }
        where.push(`root_run_id = ${push(filter.rootRunId)}`)
      }
      if (filter.tags !== undefined) {
        where.push(`tags @> ${push(json(filter.tags))}::jsonb`)
      }
      if (filter.input !== undefined) {
        where.push(`input @> ${push(json(filter.input))}::jsonb`)
      }

      const offset = filter.cursor ? Number.parseInt(filter.cursor, 10) : 0
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`Invalid run list cursor [${filter.cursor}]`)
      }

      const limit = filter.limit ?? null
      const pageLimit = limit === null ? null : limit + 1
      const rows = await many(
        db,
        `
          SELECT *
          FROM workflow_runs
          ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
          ORDER BY created_at DESC, id DESC
          ${pageLimit === null ? '' : `LIMIT ${push(pageLimit)}`}
          OFFSET ${push(offset)}
        `,
        params,
      )
      const page = limit === null ? rows : rows.slice(0, limit)
      return {
        runs: page.map(mapRun),
        ...(limit !== null && rows.length > limit
          ? { nextCursor: String(offset + limit) }
          : {}),
      }
    },
    async acquireRunLease({ runId, leaseMs }) {
      await ready
      if (!isUuid(runId)) return undefined
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined

      const leaseToken = id()
      const expiresAt = new Date(Date.now() + leaseMs)
      const lease = await one(
        db,
        `
          INSERT INTO workflow_run_leases (run_id, lease_token, version, expires_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (run_id) DO UPDATE
          SET lease_token = EXCLUDED.lease_token,
              version = EXCLUDED.version,
              expires_at = EXCLUDED.expires_at
          WHERE workflow_run_leases.expires_at <= now()
          RETURNING *
        `,
        [runId, leaseToken, run.version, expiresAt],
      )
      if (!lease) return undefined
      return {
        runId: lease.run_id as string,
        leaseToken: lease.lease_token as string,
        version: lease.version as number,
      }
    },
    async releaseRunLease(lease) {
      await ready
      if (!isUuid(lease.runId)) return
      await db.query(
        'DELETE FROM workflow_run_leases WHERE run_id = $1 AND lease_token = $2',
        [lease.runId, lease.leaseToken],
      )
    },
    async loadRunSnapshot(runId) {
      await ready
      if (!isUuid(runId)) return undefined
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined

      const [nodes, attempts, childLinks, mapItems] = await Promise.all([
        many(db, 'SELECT * FROM workflow_nodes WHERE run_id = $1', [runId]),
        many(db, 'SELECT * FROM workflow_attempts WHERE run_id = $1', [runId]),
        many(
          db,
          'SELECT * FROM workflow_child_links WHERE parent_run_id = $1',
          [runId],
        ),
        many(db, 'SELECT * FROM workflow_map_items WHERE run_id = $1', [runId]),
      ])
      return {
        run: mapRun(run),
        nodes: nodes.map(mapNode),
        attempts: attempts.map(mapAttempt),
        childLinks: childLinks.map(mapChildLink),
        mapItems: mapItems.map(mapMapItem),
      } satisfies RunSnapshot
    },
    async createNode(input) {
      await ready
      const date = new Date()
      const row = await one(
        db,
        `
          INSERT INTO workflow_nodes (
            run_id, name, kind, status, attempt_count, version, created_at, updated_at
          )
          VALUES ($1, $2, $3, 'pending', 0, 1, $4, $4)
          ON CONFLICT (run_id, name) DO UPDATE SET name = workflow_nodes.name
          RETURNING *
        `,
        [input.runId, input.name, input.kind, date],
      )
      return mapNode(row!)
    },
    async setNodeInput({ runId, nodeName, input }) {
      await ready
      const row = await one(
        db,
        `
          UPDATE workflow_nodes
          SET input = $3::jsonb,
              status = 'running',
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1 AND name = $2
          RETURNING *
        `,
        [runId, nodeName, json(input)],
      )
      if (!row) throw new Error(`Missing node [${runId}.${nodeName}]`)
      return mapNode(row)
    },
    async createAttempt(input) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [input.runId, input.nodeName],
      )
      if (!node) {
        throw new Error(`Missing node [${input.runId}.${input.nodeName}]`)
      }

      const attemptId = id()
      const leaseToken = id()
      const attempt = await one(
        db,
        `
          INSERT INTO workflow_attempts (
            id, run_id, node_name, status, lease_token, attempt_number,
            input, idempotency_key, dispatched_at
          )
          VALUES (
            $1, $2, $3, 'started', $4, $5, $6::jsonb, $7::jsonb, now()
          )
          RETURNING *
        `,
        [
          attemptId,
          input.runId,
          input.nodeName,
          leaseToken,
          (node.attempt_count as number) + 1,
          json(input.input),
          input.idempotencyKey ? json(input.idempotencyKey) : null,
        ],
      )
      await db.query(
        `
          UPDATE workflow_nodes
          SET status = 'running',
              current_attempt_id = $3,
              attempt_count = attempt_count + 1,
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1 AND name = $2
        `,
        [input.runId, input.nodeName, attemptId],
      )
      return mapAttempt(attempt!)
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      await ready
      const attempt = await one(
        db,
        'SELECT * FROM workflow_attempts WHERE id = $1',
        [attemptId],
      )
      if (
        !attempt ||
        attempt.lease_token !== leaseToken ||
        attempt.status !== 'started'
      ) {
        return undefined
      }
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [attempt.run_id, attempt.node_name],
      )
      if (
        !node ||
        (node.kind !== 'parallel' && node.current_attempt_id !== attemptId)
      ) {
        return undefined
      }

      const row = await one(
        db,
        `
          UPDATE workflow_attempts
          SET status = 'completed', output = $3::jsonb, completed_at = now()
          WHERE id = $1 AND lease_token = $2 AND status = 'started'
          RETURNING *
        `,
        [attemptId, leaseToken, json(output)],
      )
      return row ? mapAttempt(row) : undefined
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      await ready
      const attempt = await one(
        db,
        'SELECT * FROM workflow_attempts WHERE id = $1',
        [attemptId],
      )
      if (
        !attempt ||
        attempt.lease_token !== leaseToken ||
        attempt.status !== 'started'
      ) {
        return undefined
      }
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [attempt.run_id, attempt.node_name],
      )
      if (
        !node ||
        (node.kind !== 'parallel' && node.current_attempt_id !== attemptId)
      ) {
        return undefined
      }

      const row = await one(
        db,
        `
          UPDATE workflow_attempts
          SET status = 'failed', error = $3::jsonb, completed_at = now()
          WHERE id = $1 AND lease_token = $2 AND status = 'started'
          RETURNING *
        `,
        [attemptId, leaseToken, json(storedError(error))],
      )
      return row ? mapAttempt(row) : undefined
    },
    async completeNode({ runId, nodeName, output }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status as StoredNode['status'])) {
        return mapNode(node)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_nodes
          SET status = 'completed',
              output = $3::jsonb,
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1 AND name = $2
          RETURNING *
        `,
        [runId, nodeName, json(output)],
      )
      return mapNode(row!)
    },
    async failNode({ runId, nodeName, error }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status as StoredNode['status'])) {
        return mapNode(node)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_nodes
          SET status = 'failed',
              error = $3::jsonb,
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1 AND name = $2
          RETURNING *
        `,
        [runId, nodeName, json(storedError(error))],
      )
      return mapNode(row!)
    },
    async completeRun({ runId, output }) {
      await ready
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined
      if (isTerminalRunStatus(run.status as StoredRun['status'])) {
        return mapRun(run)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_runs
          SET status = 'completed',
              output = $2::jsonb,
              version = version + 1,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [runId, json(output)],
      )
      return mapRun(row!)
    },
    async failRun({ runId, error }) {
      await ready
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined
      if (isTerminalRunStatus(run.status as StoredRun['status'])) {
        return mapRun(run)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_runs
          SET status = 'failed',
              error = $2::jsonb,
              version = version + 1,
              updated_at = now()
          WHERE id = $1
          RETURNING *
        `,
        [runId, json(storedError(error))],
      )
      return mapRun(row!)
    },
    async ensureNodeAttempt(params) {
      await ready
      const key = identityKey(params.identity)
      const existing = await one(
        db,
        'SELECT * FROM workflow_attempts WHERE identity_key = $1',
        [key],
      )
      if (existing) return { attempt: mapAttempt(existing), created: false }

      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [params.identity.runId, params.identity.nodeName],
      )
      if (!node) {
        throw new Error(
          `Missing node [${params.identity.runId}.${params.identity.nodeName}]`,
        )
      }
      if (
        (node.kind === 'activity' || node.kind === 'task') &&
        node.kind !== params.kind
      ) {
        throw new Error(
          `Node [${String(node.run_id)}.${String(node.name)}] kind [${String(node.kind)}] cannot create [${params.kind}] attempt`,
        )
      }

      const attemptId = id()
      const leaseToken = id()
      const attempt = await one(
        db,
        `
          INSERT INTO workflow_attempts (
            id, run_id, node_name, identity_key, identity, status,
            lease_token, attempt_number, input, idempotency_key, dispatched_at
          )
          VALUES (
            $1, $2, $3, $4, $5::jsonb, 'started',
            $6, $7, $8::jsonb, $9::jsonb, now()
          )
          RETURNING *
        `,
        [
          attemptId,
          params.identity.runId,
          params.identity.nodeName,
          key,
          json(params.identity),
          leaseToken,
          (node.attempt_count as number) + 1,
          json(params.input),
          params.idempotencyKey ? json(params.idempotencyKey) : null,
        ],
      )
      await db.query(
        `
          UPDATE workflow_nodes
          SET status = 'waiting',
              current_attempt_id = $3,
              attempt_count = attempt_count + 1,
              version = version + 1,
              updated_at = now()
          WHERE run_id = $1 AND name = $2
        `,
        [params.identity.runId, params.identity.nodeName, attemptId],
      )
      return { attempt: mapAttempt(attempt!), created: true }
    },
    async ensureChildRun(params) {
      await ready
      if (
        params.identity.runId !== params.parentRunId ||
        params.identity.nodeName !== params.parentNodeName
      ) {
        throw new Error(
          `Child identity does not match parent node [${params.parentRunId}.${params.parentNodeName}]`,
        )
      }

      const key = identityKey(params.identity)
      const existingLink = await one(
        db,
        'SELECT * FROM workflow_child_links WHERE identity_key = $1',
        [key],
      )
      if (existingLink) {
        const childRun = await one(
          db,
          'SELECT * FROM workflow_runs WHERE id = $1',
          [existingLink.child_run_id],
        )
        if (!childRun) {
          throw new Error(
            `Missing child run [${String(existingLink.child_run_id)}]`,
          )
        }
        const link = mapChildLink(existingLink)
        const run = mapRun(childRun)
        if (
          link.childKind !== params.childKind ||
          link.childName !== params.childName ||
          run.kind !== params.childKind ||
          run.name !== params.childName ||
          !sameValue(run.input, params.input) ||
          !sameOptionalValue(run.idempotencyKey, params.idempotencyKey)
        ) {
          throw new Error(
            `Conflicting child run [${params.parentRunId}.${params.parentNodeName}]`,
          )
        }
        return { childLink: link, childRun: run, created: false }
      }

      const childRun = await store.createRun({
        kind: params.childKind,
        name: params.childName,
        workflowName: params.childName,
        ...(params.childKind === 'task' ? { taskName: params.childName } : {}),
        input: params.input,
        parentRunId: params.parentRunId,
        parentNodeName: params.parentNodeName,
        rootRunId: params.rootRunId,
        tags: params.tags,
        idempotencyKey: params.idempotencyKey,
      })
      const link = await one(
        db,
        `
          INSERT INTO workflow_child_links (
            identity_key, identity, parent_run_id, parent_node_name,
            child_run_id, child_kind, child_name, workflow_name, task_name,
            case_key, member_key, item_index, item_key
          )
          VALUES (
            $1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
          )
          RETURNING *
        `,
        [
          key,
          json(params.identity),
          params.parentRunId,
          params.parentNodeName,
          childRun.id,
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
      return { childLink: mapChildLink(link!), childRun, created: true }
    },
    async ensureChildWorkflowRun(params) {
      return store.ensureChildRun({
        identity: params.identity,
        childKind: 'workflow',
        childName: params.workflowName,
        input: params.input,
        parentRunId: params.parentRunId,
        parentNodeName: params.parentNodeName,
        rootRunId: params.rootRunId,
        tags: params.tags,
        idempotencyKey: params.idempotencyKey,
      })
    },
    async selectNodeCase({ runId, nodeName, caseKey }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (node.selected_case === caseKey) return mapNode(node)
      if (node.selected_case !== null) {
        throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_nodes
          SET selected_case = $3, version = version + 1, updated_at = now()
          WHERE run_id = $1 AND name = $2
          RETURNING *
        `,
        [runId, nodeName, caseKey],
      )
      return mapNode(row!)
    },
    async ensureMapItems(params) {
      await ready
      const key = `${params.runId}:${params.nodeName}`
      if (params.keys && params.keys.length !== params.items.length) {
        throw new Error(`Conflicting map items for [${key}]`)
      }
      const keys = params.items.map((_, index) => params.keys?.[index])
      const definedKeys = keys.filter((itemKey) => itemKey !== undefined)
      if (new Set(definedKeys).size !== definedKeys.length) {
        throw new Error(`Duplicate map item key for [${key}]`)
      }

      const existingSet = await one(
        db,
        `
          SELECT *
          FROM workflow_map_item_sets
          WHERE run_id = $1 AND node_name = $2
        `,
        [params.runId, params.nodeName],
      )
      const existingItems = await many(
        db,
        `
          SELECT *
          FROM workflow_map_items
          WHERE run_id = $1 AND node_name = $2
          ORDER BY item_index ASC
        `,
        [params.runId, params.nodeName],
      )
      if (existingSet) {
        const existingKeys = existingSet.keys as readonly (string | undefined)[]
        const sameKeys =
          existingKeys.length === keys.length &&
          existingKeys.every((existingKey, index) => existingKey === keys[index])
        if (!sameKeys) throw new Error(`Conflicting map items for [${key}]`)
        const sameItems =
          existingItems.length === params.items.length &&
          existingItems.every((existingItem, index) =>
            sameValue(existingItem.item, params.items[index]),
          )
        if (!sameItems) throw new Error(`Conflicting map items for [${key}]`)
        return { items: existingItems.map(mapMapItem), created: false }
      }

      await db.query(
        `
          INSERT INTO workflow_map_item_sets (run_id, node_name, keys)
          VALUES ($1, $2, $3::jsonb)
        `,
        [params.runId, params.nodeName, json(keys)],
      )
      for (const [index, item] of params.items.entries()) {
        const itemKey = params.keys?.[index]
        const identity: NodeChildIdentity = {
          runId: params.runId,
          nodeName: params.nodeName,
          itemIndex: index,
          ...(itemKey === undefined ? {} : { itemKey }),
        }
        await db.query(
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
            identityKey(identity),
            json(identity),
            itemKey ?? null,
            json(item),
          ],
        )
      }
      const created = await many(
        db,
        `
          SELECT *
          FROM workflow_map_items
          WHERE run_id = $1 AND node_name = $2
          ORDER BY item_index ASC
        `,
        [params.runId, params.nodeName],
      )
      return { items: created.map(mapMapItem), created: true }
    },
    async completeMapItem(params) {
      await ready
      const item = await one(
        db,
        `
          SELECT *
          FROM workflow_map_items
          WHERE run_id = $1 AND node_name = $2 AND item_index = $3
            AND item_key IS NOT DISTINCT FROM $4
        `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
        ],
      )
      if (!item) return undefined
      if (isTerminalNodeStatus(item.status as StoredMapItem['status'])) {
        return mapMapItem(item)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_map_items
          SET status = 'completed', output = $5::jsonb
          WHERE run_id = $1 AND node_name = $2 AND item_index = $3
            AND item_key IS NOT DISTINCT FROM $4
          RETURNING *
        `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
          json(params.output),
        ],
      )
      return mapMapItem(row!)
    },
    async failMapItem(params) {
      await ready
      const item = await one(
        db,
        `
          SELECT *
          FROM workflow_map_items
          WHERE run_id = $1 AND node_name = $2 AND item_index = $3
            AND item_key IS NOT DISTINCT FROM $4
        `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
        ],
      )
      if (!item) return undefined
      if (isTerminalNodeStatus(item.status as StoredMapItem['status'])) {
        return mapMapItem(item)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_map_items
          SET status = 'failed', error = $5::jsonb
          WHERE run_id = $1 AND node_name = $2 AND item_index = $3
            AND item_key IS NOT DISTINCT FROM $4
          RETURNING *
        `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
          json(storedError(params.error)),
        ],
      )
      return mapMapItem(row!)
    },
    async waitNode({ runId, nodeName }) {
      await ready
      const node = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!node) return undefined
      if (
        isTerminalNodeStatus(node.status as StoredNode['status']) ||
        node.status === 'waiting'
      ) {
        return mapNode(node)
      }
      const row = await one(
        db,
        `
          UPDATE workflow_nodes
          SET status = 'waiting', version = version + 1, updated_at = now()
          WHERE run_id = $1 AND name = $2
          RETURNING *
        `,
        [runId, nodeName],
      )
      return mapNode(row!)
    },
    async loadNodeChildren({ runId, nodeName }) {
      await ready
      const [attempts, childLinks, mapItems] = await Promise.all([
        many(
          db,
          'SELECT * FROM workflow_attempts WHERE run_id = $1 AND node_name = $2',
          [runId, nodeName],
        ),
        many(
          db,
          `
            SELECT *
            FROM workflow_child_links
            WHERE parent_run_id = $1 AND parent_node_name = $2
          `,
          [runId, nodeName],
        ),
        many(
          db,
          'SELECT * FROM workflow_map_items WHERE run_id = $1 AND node_name = $2',
          [runId, nodeName],
        ),
      ])
      return {
        attempts: attempts.map(mapAttempt),
        childLinks: childLinks.map(mapChildLink),
        mapItems: mapItems.map(mapMapItem),
      }
    },
  }

  const runCoordinationExecutor: RunCoordinationExecutor = {
    async enqueue(command) {
      await ready
      await db.query(
        `
          INSERT INTO workflow_commands (
            id, kind, run_id, workflow_name, payload
          )
          VALUES ($1, 'continue', $2, $3, $4::jsonb)
        `,
        [id(), command.runId, command.workflowName, json(command)],
      )
    },
    async enqueueDelayed(command, runAt) {
      await ready
      await db.query(
        `
          INSERT INTO workflow_commands (
            id, kind, run_id, workflow_name, payload, run_at
          )
          VALUES ($1, 'continue', $2, $3, $4::jsonb, $5)
        `,
        [id(), command.runId, command.workflowName, json(command), runAt],
      )
    },
    async claim(worker) {
      await ready
      if (worker.workflowNames.length === 0) return null
      const workflowList = worker.workflowNames
        .map((_, index) => `$${index + 2}`)
        .join(', ')
      const claimed = await claimCommand(
        'continue',
        `workflow_name IN (${workflowList})`,
        [...worker.workflowNames],
        worker.workerId,
        worker.leaseMs,
      )
      if (!claimed) return null
      return {
        id: claimed.id as string,
        command: claimed.payload as ContinueRunCommand,
        leaseToken: claimed.lease_token as string,
      }
    },
    async ack(command) {
      await ready
      await ackCommand(command.id, command.leaseToken)
    },
    async release(command) {
      await ready
      await db.query(
        `
          UPDATE workflow_commands
          SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1 AND lease_token = $2
        `,
        [command.id, command.leaseToken],
      )
    },
  }

  const claimCommand = async (
    kind: 'continue' | 'activity' | 'task',
    where: string,
    params: unknown[],
    workerId: string,
    leaseMs: number,
  ) => {
    const leaseToken = id()
    return await one(
      db,
      `
        WITH candidate AS (
          SELECT id
          FROM workflow_commands
          WHERE kind = $1
            AND run_at <= now()
            AND (lease_token IS NULL OR lease_expires_at <= now())
            AND ${where}
          ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE workflow_commands
        SET lease_owner = $${params.length + 2},
            lease_token = $${params.length + 3},
            lease_expires_at = $${params.length + 4}
        WHERE id = (SELECT id FROM candidate)
        RETURNING *
      `,
      [
        kind,
        ...params,
        workerId,
        leaseToken,
        new Date(Date.now() + leaseMs),
      ],
    )
  }

  const claimAttempt = async (
    kind: 'activity' | 'task',
    where: string,
    params: unknown[],
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedAttempt | null> => {
    const claimed = await claimCommand(kind, where, params, workerId, leaseMs)
    if (!claimed) return null
    return {
      id: claimed.id as string,
      command: claimed.payload as AttemptCommand,
      leaseToken: claimed.lease_token as string,
    }
  }

  const ackCommand = async (commandId: string, leaseToken: string) => {
    const deleted = await one<{ id: string }>(
      db,
      `
        DELETE FROM workflow_commands
        WHERE id = $1 AND lease_token = $2
        RETURNING id
      `,
      [commandId, leaseToken],
    )

    if (!deleted) throw new Error('Stale workflow command ack')
  }

  const attemptExecutor: AttemptExecutor = {
    async dispatchActivity(command: ActivityAttemptCommand) {
      await ready
      await db.query(
        `
          INSERT INTO workflow_commands (
            id,
            kind,
            run_id,
            workflow_name,
            activity_name,
            node_name,
            attempt_id,
            payload
          )
          VALUES ($1, 'activity', $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [
          id(),
          command.runId,
          command.workflowName,
          command.activityName,
          command.nodeName,
          command.attemptId,
          json(command),
        ],
      )
    },
    async dispatchTask(command: TaskAttemptCommand) {
      await ready
      await db.query(
        `
          INSERT INTO workflow_commands (
            id,
            kind,
            run_id,
            workflow_name,
            task_name,
            node_name,
            attempt_id,
            payload
          )
          VALUES ($1, 'task', $2, $3, $4, $5, $6, $7::jsonb)
        `,
        [
          id(),
          command.runId,
          command.workflowName,
          command.taskName,
          command.nodeName,
          command.attemptId,
          json(command),
        ],
      )
    },
    async claimActivity(worker) {
      await ready
      if (worker.workflowNames.length === 0) return null
      const params: unknown[] = [...worker.workflowNames]
      const workflowList = worker.workflowNames
        .map((_, index) => `$${index + 2}`)
        .join(', ')
      const where = [`workflow_name IN (${workflowList})`]
      if (worker.activityNames !== undefined) {
        const offset = params.length
        params.push(...worker.activityNames)
        where.push(
          `activity_name IN (${worker.activityNames
            .map((_, index) => `$${offset + index + 2}`)
            .join(', ')})`,
        )
      }
      return claimAttempt(
        'activity',
        where.join(' AND '),
        params,
        worker.workerId,
        worker.leaseMs,
      )
    },
    async claimTask(worker) {
      await ready
      if (worker.taskNames.length === 0) return null
      const taskList = worker.taskNames
        .map((_, index) => `$${index + 2}`)
        .join(', ')
      return claimAttempt(
        'task',
        `task_name IN (${taskList})`,
        [...worker.taskNames],
        worker.workerId,
        worker.leaseMs,
      )
    },
    async heartbeat() {},
    async ack(attempt) {
      await ready
      await ackCommand(attempt.id, attempt.leaseToken)
    },
    async release(attempt) {
      await ready
      await db.query(
        `
          UPDATE workflow_commands
          SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE id = $1 AND lease_token = $2
        `,
        [attempt.id, attempt.leaseToken],
      )
    },
  }

  const atomicStart: WorkflowRuntimeAtomicStart = {
    startWorkflowRun: ({ run }) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        const started = await runtime.store.createRun(run)
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: started.id,
          workflowName: started.workflowName,
        })
        return started
      }),
    startTaskRun: ({ run, taskName, taskInput, idempotencyKey }) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        const started = await runtime.store.createRun(run)
        await runtime.store.createNode({
          runId: started.id,
          name: TASK_RUN_NODE_NAME,
          kind: 'task',
        })
        await runtime.store.setNodeInput({
          runId: started.id,
          nodeName: TASK_RUN_NODE_NAME,
          input: taskInput,
        })
        const result = await runtime.store.ensureNodeAttempt({
          identity: {
            runId: started.id,
            nodeName: TASK_RUN_NODE_NAME,
          },
          kind: 'task',
          input: taskInput,
          ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        })
        await runtime.attemptExecutor.dispatchTask({
          kind: 'taskAttempt',
          workflowName: taskName,
          taskName,
          runId: started.id,
          nodeName: TASK_RUN_NODE_NAME,
          attemptId: result.attempt.id,
          leaseToken: result.attempt.leaseToken!,
          input: result.created ? taskInput : result.attempt.input,
          ...(result.attempt.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: result.attempt.idempotencyKey }),
        })
        return started
      }),
  }

  const atomicCompletion: WorkflowRuntimeAtomicCompletion = {
    run: (handler) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        return await handler({
          store: runtime.store,
          runCoordinationExecutor: runtime.runCoordinationExecutor,
          attemptExecutor: runtime.attemptExecutor,
        })
      }),
  }

  const atomicContinuation: WorkflowRuntimeAtomicContinuation = {
    run: (handler) =>
      db.transaction(async (tx) => {
        const runtime = createPostgresWorkflowRuntime({ connection: tx })
        return await handler({
          store: runtime.store,
          runCoordinationExecutor: runtime.runCoordinationExecutor,
          attemptExecutor: runtime.attemptExecutor,
        })
      }),
  }

  return {
    store,
    runCoordinationExecutor,
    attemptExecutor,
    atomicStart,
    atomicContinuation,
    atomicCompletion,
    connection: db,
  }
}
