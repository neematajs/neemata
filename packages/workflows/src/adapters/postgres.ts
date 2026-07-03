import { randomUUID } from 'node:crypto'

import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../runtime/commands.ts'
import type { WorkflowRuntimeAtomicStart } from '../runtime/coordinator.ts'
import type {
  AttemptExecutor,
  RunCoordinationExecutor,
} from '../runtime/executors.ts'
import type {
  NodeChildIdentity,
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredMapItem,
  StoredNode,
  StoredError,
  StoredRun,
} from '../runtime/state.ts'
import type {
  CreateRunInput,
  DeadWorkflowCommand,
  ListRunsFilter,
  WorkflowStore,
} from '../runtime/store.ts'
import type {
  WorkflowRuntimeAtomicCompletion,
  WorkflowRuntimeAtomicContinuation,
} from '../runtime/worker.ts'
import { toStoredError } from '../runtime/errors.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../runtime/status.ts'

type JsonRecord = Record<string, unknown>

export type WorkflowPostgresQueryResult<T extends JsonRecord = JsonRecord> = {
  readonly rows: readonly T[]
}

export type WorkflowPostgresConnection = {
  query<T extends JsonRecord = JsonRecord>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<WorkflowPostgresQueryResult<T>>
  transaction<T>(
    handler: (connection: WorkflowPostgresConnection) => Promise<T>,
  ): Promise<T>
}

type PostgresWorkflowRuntime = WorkflowRuntimeAdapter & {
  readonly connection: WorkflowPostgresConnection
}

const RELEASE_BACKOFF_MS = 50
const MAX_ERROR_BACKOFF_MS = 300_000
const DEFAULT_MAX_DELIVERIES = 20

export type WorkflowPostgresQueryClient = {
  query<T extends JsonRecord = JsonRecord>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<WorkflowPostgresQueryResult<T>>
}

export type WorkflowPostgresPoolClient = WorkflowPostgresQueryClient & {
  release(): void
}

export type WorkflowPostgresPool = WorkflowPostgresQueryClient & {
  connect(): Promise<WorkflowPostgresPoolClient>
}

export type WorkflowPostgresTransactionClient = WorkflowPostgresQueryClient & {
  transaction<T>(
    handler: (connection: WorkflowPostgresQueryClient) => Promise<T>,
  ): Promise<T>
}

type WorkflowPostgresExternalClient =
  | WorkflowPostgresQueryClient
  | WorkflowPostgresPool
  | WorkflowPostgresTransactionClient

const hasTransactionApi = (
  client: WorkflowPostgresExternalClient,
): client is WorkflowPostgresTransactionClient =>
  'transaction' in client && typeof client.transaction === 'function'

const hasConnectApi = (
  client: WorkflowPostgresExternalClient,
): client is WorkflowPostgresPool =>
  'connect' in client &&
  typeof client.connect === 'function' &&
  ('totalCount' in client || 'idleCount' in client || 'waitingCount' in client)

const queryPostgresClient = <T extends JsonRecord>(
  client: WorkflowPostgresQueryClient,
  sql: string,
  params: readonly unknown[] = [],
) => client.query<T>(sql, [...params])

const createTransactionConnection = (
  client: WorkflowPostgresQueryClient,
): WorkflowPostgresConnection => ({
  query: (sql, params = []) => queryPostgresClient(client, sql, params),
  transaction: (handler) => handler(createTransactionConnection(client)),
})

const rollbackIgnoringFailure = async (client: WorkflowPostgresQueryClient) => {
  try {
    await client.query('ROLLBACK')
  } catch {}
}

export function createPostgresWorkflowConnection(
  client: WorkflowPostgresExternalClient,
): WorkflowPostgresConnection {
  let plainClientTransactionQueue = Promise.resolve()
  const runPlainClientTransaction = async <T>(
    handler: () => Promise<T>,
  ): Promise<T> => {
    const previous = plainClientTransactionQueue
    let release = () => {}
    plainClientTransactionQueue = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await handler()
    } finally {
      release()
    }
  }

  return {
    query: (sql, params = []) => queryPostgresClient(client, sql, params),
    async transaction(handler) {
      if (hasTransactionApi(client)) {
        return client.transaction((tx) =>
          handler(createTransactionConnection(tx)),
        )
      }

      if (hasConnectApi(client)) {
        const tx = await client.connect()
        try {
          await tx.query('BEGIN')
          const result = await handler(createTransactionConnection(tx))
          await tx.query('COMMIT')
          return result
        } catch (error) {
          await rollbackIgnoringFailure(tx)
          throw error
        } finally {
          tx.release()
        }
      }

      return runPlainClientTransaction(async () => {
        try {
          await client.query('BEGIN')
          const result = await handler(createTransactionConnection(client))
          await client.query('COMMIT')
          return result
        } catch (error) {
          await rollbackIgnoringFailure(client)
          throw error
        }
      })
    },
  }
}

export const WORKFLOW_POSTGRES_SCHEMA_VERSION = 3
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
    'workflow_commands_run_fk',
  ],
  indexes: [
    'workflow_runs_idempotency_idx',
    'workflow_runs_parent_idx',
    'workflow_runs_root_idx',
    'workflow_runs_input_gin_idx',
    'workflow_runs_tags_gin_idx',
    'workflow_attempts_node_idx',
    'workflow_child_links_parent_node_idx',
    'workflow_commands_run_idx',
    'workflow_commands_claim_idx',
    'workflow_commands_continue_dedup_idx',
  ],
  constraintDefinitions: {
    workflow_attempts_identity_key_key: {
      table: 'workflow_attempts',
      type: 'u',
      columns: ['identity_key'],
    },
    workflow_map_items_identity_key_key: {
      table: 'workflow_map_items',
      type: 'u',
      columns: ['identity_key'],
    },
    workflow_commands_run_fk: {
      table: 'workflow_commands',
      type: 'f',
      columns: ['run_id'],
    },
  },
  indexDefinitions: {
    workflow_runs_idempotency_idx: {
      table: 'workflow_runs',
      unique: true,
      columns: ['idempotency_key'],
      predicate: 'idempotency_key IS NOT NULL',
    },
    workflow_runs_parent_idx: {
      table: 'workflow_runs',
      unique: false,
      columns: ['parent_run_id'],
      predicate: 'parent_run_id IS NOT NULL',
    },
    workflow_runs_root_idx: {
      table: 'workflow_runs',
      unique: false,
      columns: ['root_run_id'],
    },
    workflow_runs_input_gin_idx: {
      table: 'workflow_runs',
      unique: false,
      columns: ['input'],
    },
    workflow_runs_tags_gin_idx: {
      table: 'workflow_runs',
      unique: false,
      columns: ['tags'],
    },
    workflow_commands_claim_idx: {
      table: 'workflow_commands',
      unique: false,
      columns: ['kind', 'priority', 'run_at', 'created_at', 'id'],
      directions: ['ASC', 'DESC', 'ASC', 'ASC', 'ASC'],
    },
    workflow_commands_run_idx: {
      table: 'workflow_commands',
      unique: false,
      columns: ['run_id'],
    },
    workflow_commands_continue_dedup_idx: {
      table: 'workflow_commands',
      unique: true,
      columns: ['run_id'],
      predicate:
        "kind = 'continue'::workflow_command_kind AND lease_token IS NULL",
    },
    workflow_attempts_node_idx: {
      table: 'workflow_attempts',
      unique: false,
      columns: ['run_id', 'node_name'],
    },
    workflow_child_links_parent_node_idx: {
      table: 'workflow_child_links',
      unique: false,
      columns: ['parent_run_id', 'parent_node_name'],
    },
  },
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
      delivery_count: { type: 'int4', nullable: false },
      last_error: { type: 'jsonb', nullable: true },
      dead_at: { type: 'timestamptz', nullable: true },
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
const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    )
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && sameValue(left[key], right[key]),
      )
    )
  }
  return false
}
const sameOptionalValue = (left: unknown, right: unknown) =>
  left === undefined && right === undefined
    ? true
    : left !== undefined && right !== undefined && sameValue(left, right)
const stringArray = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string') return []
  const content =
    value.startsWith('{') && value.endsWith('}') ? value.slice(1, -1) : value
  if (!content) return []
  return content.split(',').map((item) => item.replaceAll('"', ''))
}
const sameStringArray = (left: unknown, right: readonly string[]) => {
  const normalized = stringArray(left)
  return (
    normalized.length === right.length &&
    normalized.every((item, index) => item === right[index])
  )
}
const normalizeIndexPredicate = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replaceAll('"', '')
        .replace(/[()]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
    : undefined
const isUniqueViolation = (error: unknown) =>
  (typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505') ||
  (typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    String(error.message).includes(
      'duplicate key value violates unique constraint',
    ))

const identityKey = (identity: NodeChildIdentity) =>
  JSON.stringify([
    identity.runId,
    identity.nodeName,
    identity.caseKey ?? null,
    identity.memberKey ?? null,
    identity.itemIndex ?? null,
    identity.itemKey ?? null,
  ])

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

const mapDeadCommand = (row: JsonRecord): DeadWorkflowCommand => ({
  id: row.id as string,
  kind: row.kind as DeadWorkflowCommand['kind'],
  runId: row.run_id as string,
  ...optional('workflowName', row.workflow_name as string | undefined),
  ...optional('taskName', row.task_name as string | undefined),
  ...optional('activityName', row.activity_name as string | undefined),
  ...optional('nodeName', row.node_name as string | undefined),
  ...optional('attemptId', row.attempt_id as string | undefined),
  payload: row.payload,
  deliveryCount: row.delivery_count as number,
  ...optional(
    'lastError',
    fromOptional(row.last_error) as StoredError | undefined,
  ),
  deadAt: row.dead_at as Date,
  createdAt: row.created_at as Date,
})

const parseJsonColumn = (value: unknown): unknown =>
  typeof value === 'string' ? JSON.parse(value) : value

const jsonRecordColumn = (value: unknown): JsonRecord | undefined => {
  const parsed = parseJsonColumn(value)
  return isRecord(parsed) ? parsed : undefined
}

const jsonRecordArrayColumn = (value: unknown): JsonRecord[] => {
  const parsed = parseJsonColumn(value)
  return Array.isArray(parsed) ? parsed.filter(isRecord) : []
}

const dateColumn = (value: unknown): unknown =>
  value instanceof Date
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : value

const withDateColumns = (
  row: JsonRecord,
  columns: readonly string[],
): JsonRecord => {
  const next = { ...row }
  for (const column of columns) {
    if (next[column] !== null && next[column] !== undefined) {
      next[column] = dateColumn(next[column])
    }
  }
  return next
}

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
  const [
    enums,
    enumLabels,
    tables,
    columns,
    constraints,
    indexes,
    constraintDefinitions,
    indexDefinitions,
  ] = await Promise.all([
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
    many<{
      name: string
      table_name: string
      type: string
      columns: unknown
    }>(
      db,
      `
          SELECT
            c.conname AS name,
            rel.relname AS table_name,
            c.contype AS type,
            array_remove(array_agg(att.attname ORDER BY ord.ordinality), NULL) AS columns
          FROM pg_constraint c
          JOIN pg_class rel ON rel.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = rel.relnamespace
          LEFT JOIN unnest(c.conkey) WITH ORDINALITY AS ord(attnum, ordinality)
            ON true
          LEFT JOIN pg_attribute att
            ON att.attrelid = rel.oid AND att.attnum = ord.attnum
          WHERE n.nspname = current_schema()
            AND c.conname = ANY($1)
          GROUP BY c.conname, rel.relname, c.contype
        `,
      [Object.keys(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraintDefinitions)],
    ),
    many<{
      name: string
      table_name: string
      unique: boolean
      columns: unknown
      directions: unknown
      predicate: string | null
    }>(
      db,
      `
          SELECT
            idx.relname AS name,
            tbl.relname AS table_name,
            i.indisunique AS unique,
            array_remove(array_agg(att.attname ORDER BY ord.ordinality), NULL) AS columns,
            array_remove(
              array_agg(
                CASE
                  WHEN (i.indoption[ord.ordinality - 1]::int & 1) = 1
                    THEN 'DESC'
                  ELSE 'ASC'
                END
                ORDER BY ord.ordinality
              ),
              NULL
            ) AS directions,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
          FROM pg_index i
          JOIN pg_class idx ON idx.oid = i.indexrelid
          JOIN pg_class tbl ON tbl.oid = i.indrelid
          JOIN pg_namespace n ON n.oid = tbl.relnamespace
          LEFT JOIN unnest(i.indkey) WITH ORDINALITY AS ord(attnum, ordinality)
            ON true
          LEFT JOIN pg_attribute att
            ON att.attrelid = tbl.oid AND att.attnum = ord.attnum
          WHERE n.nspname = current_schema()
            AND idx.relname = ANY($1)
          GROUP BY idx.relname, tbl.relname, i.indisunique, i.indpred, i.indrelid
        `,
      [Object.keys(WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexDefinitions)],
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
    .filter(
      ([name, values]) =>
        JSON.stringify(labelsByEnum.get(name) ?? []) !== JSON.stringify(values),
    )
    .map(([name]) => name)

  if (invalidEnums.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema enums: ${invalidEnums.join(', ')}`,
    )
  }

  const constraintDefinitionsByName = new Map(
    constraintDefinitions.map((definition) => [definition.name, definition]),
  )
  const invalidConstraints = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.constraintDefinitions,
  )
    .filter(([name, expected]) => {
      const actual = constraintDefinitionsByName.get(name)
      return (
        !actual ||
        actual.table_name !== expected.table ||
        actual.type !== expected.type ||
        !sameStringArray(actual.columns, expected.columns)
      )
    })
    .map(([name]) => name)

  if (invalidConstraints.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema constraints: ${invalidConstraints.join(', ')}`,
    )
  }

  const indexDefinitionsByName = new Map(
    indexDefinitions.map((definition) => [definition.name, definition]),
  )
  const invalidIndexes = Object.entries(
    WORKFLOW_POSTGRES_SCHEMA_MANIFEST.indexDefinitions,
  )
    .filter(([name, expected]) => {
      const actual = indexDefinitionsByName.get(name)
      return (
        !actual ||
        actual.table_name !== expected.table ||
        actual.unique !== expected.unique ||
        !sameStringArray(actual.columns, expected.columns) ||
        !sameStringArray(
          actual.directions,
          'directions' in expected
            ? expected.directions
            : expected.columns.map(() => 'ASC'),
        ) ||
        normalizeIndexPredicate(actual.predicate) !==
          normalizeIndexPredicate(
            'predicate' in expected ? expected.predicate : undefined,
          )
      )
    })
    .map(([name]) => name)

  if (invalidIndexes.length > 0) {
    throw new Error(
      `Invalid workflow Postgres schema indexes: ${invalidIndexes.join(', ')}`,
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

export function createPostgresWorkflowRuntime(params: {
  readonly connection: WorkflowPostgresConnection
  readonly maxDeliveries?: number
}): PostgresWorkflowRuntime {
  const db = params.connection
  const ready = Promise.resolve()
  const maxDeliveries = params.maxDeliveries ?? DEFAULT_MAX_DELIVERIES

  const createStoredRun = async (
    connection: WorkflowPostgresConnection,
    input: CreateRunInput,
    options: { readonly recoverUniqueViolation?: boolean } = {},
  ) => {
    const recoverUniqueViolation = options.recoverUniqueViolation ?? true
    const loadIdempotentRun = async () => {
      if (!input.idempotencyKey) return undefined
      const existing = await one(
        connection,
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
      return undefined
    }
    const existing = await loadIdempotentRun()
    if (existing) return existing

    const date = now()
    const runId = id()
    try {
      const row = await one(
        connection,
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
    } catch (error) {
      if (
        recoverUniqueViolation &&
        input.idempotencyKey &&
        isUniqueViolation(error)
      ) {
        const raced = await loadIdempotentRun()
        if (raced) return raced
      }
      throw error
    }
  }

  const store: WorkflowStore = {
    async createRun(input) {
      await ready
      return createStoredRun(db, input)
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
    async listDeadCommands() {
      await ready
      const rows = await many(
        db,
        `
          SELECT *
          FROM workflow_commands
          WHERE dead_at IS NOT NULL
          ORDER BY dead_at DESC, created_at DESC, id ASC
        `,
      )
      return rows
        .map((row) => withDateColumns(row, ['dead_at', 'created_at', 'run_at']))
        .map(mapDeadCommand)
    },
    async requeueDeadCommand(commandId) {
      await ready
      await db.query(
        `
          UPDATE workflow_commands
          SET delivery_count = 0,
              last_error = NULL,
              dead_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              run_at = now()
          WHERE id = $1
            AND dead_at IS NOT NULL
        `,
        [commandId],
      )
    },
    async acquireRunLease({ runId, leaseMs }) {
      await ready
      if (!isUuid(runId)) return undefined
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined

      const leaseToken = id()
      const lease = await one(
        db,
        `
          INSERT INTO workflow_run_leases (run_id, lease_token, version, expires_at)
          VALUES ($1, $2, $3, now() + ($4::int * interval '1 millisecond'))
          ON CONFLICT (run_id) DO UPDATE
          SET lease_token = EXCLUDED.lease_token,
              version = EXCLUDED.version,
              expires_at = EXCLUDED.expires_at
          WHERE workflow_run_leases.expires_at <= now()
          RETURNING *
        `,
        [runId, leaseToken, run.version, leaseMs],
      )
      if (!lease) return undefined
      return {
        runId: lease.run_id as string,
        leaseToken: lease.lease_token as string,
        version: lease.version as number,
      }
    },
    async renewRunLease(lease, leaseMs) {
      await ready
      if (!isUuid(lease.runId)) return undefined
      const renewedLease = await one(
        db,
        `
          UPDATE workflow_run_leases
          SET expires_at = now() + ($3::int * interval '1 millisecond')
          WHERE run_id = $1 AND lease_token = $2
          RETURNING *
        `,
        [lease.runId, lease.leaseToken, leaseMs],
      )
      if (!renewedLease) return undefined
      return {
        runId: renewedLease.run_id as string,
        leaseToken: renewedLease.lease_token as string,
        version: renewedLease.version as number,
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
      const snapshot = await one<
        JsonRecord & {
          run: unknown
          nodes: unknown
          attempts: unknown
          child_links: unknown
          map_items: unknown
        }
      >(
        db,
        `
          SELECT
            (SELECT to_jsonb(r) FROM workflow_runs r WHERE r.id = $1) AS run,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(n)) FROM workflow_nodes n WHERE n.run_id = $1),
              '[]'::jsonb
            ) AS nodes,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(a)) FROM workflow_attempts a WHERE a.run_id = $1),
              '[]'::jsonb
            ) AS attempts,
            COALESCE(
              (
                SELECT jsonb_agg(to_jsonb(c))
                FROM workflow_child_links c
                WHERE c.parent_run_id = $1
              ),
              '[]'::jsonb
            ) AS child_links,
            COALESCE(
              (SELECT jsonb_agg(to_jsonb(m)) FROM workflow_map_items m WHERE m.run_id = $1),
              '[]'::jsonb
            ) AS map_items
        `,
        [runId],
      )
      const run = jsonRecordColumn(snapshot?.run)
      if (!run) return undefined

      const nodes = jsonRecordArrayColumn(snapshot.nodes).map((node) =>
        withDateColumns(node, ['created_at', 'updated_at', 'next_attempt_at']),
      )
      const attempts = jsonRecordArrayColumn(snapshot.attempts).map((attempt) =>
        withDateColumns(attempt, [
          'dispatched_at',
          'heartbeat_at',
          'completed_at',
        ]),
      )
      const childLinks = jsonRecordArrayColumn(snapshot.child_links)
      const mapItems = jsonRecordArrayColumn(snapshot.map_items)

      return {
        run: mapRun(withDateColumns(run, ['created_at', 'updated_at'])),
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
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [runId, nodeName, json(input)],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!current) throw new Error(`Missing node [${runId}.${nodeName}]`)
      return mapNode(current)
    },
    async createAttempt(input) {
      await ready
      return db.transaction(async (tx) => {
        const node = await one(
          tx,
          'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
          [input.runId, input.nodeName],
        )
        if (!node) {
          throw new Error(`Missing node [${input.runId}.${input.nodeName}]`)
        }

        const attemptId = id()
        const leaseToken = id()
        const attempt = await one(
          tx,
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
        const updatedNode = await one(
          tx,
          `
            UPDATE workflow_nodes
            SET status = 'running',
                current_attempt_id = $3,
                attempt_count = attempt_count + 1,
                version = version + 1,
                updated_at = now()
            WHERE run_id = $1 AND name = $2
              AND status NOT IN ('completed', 'failed', 'cancelled')
            RETURNING *
          `,
          [input.runId, input.nodeName, attemptId],
        )
        if (!updatedNode) {
          throw new Error(
            `Terminal node [${input.runId}.${input.nodeName}] cannot create attempt`,
          )
        }
        return mapAttempt(attempt!)
      })
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
        isTerminalNodeStatus(node.status as StoredNode['status']) ||
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
        isTerminalNodeStatus(node.status as StoredNode['status']) ||
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
        [attemptId, leaseToken, json(toStoredError(error))],
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
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [runId, nodeName, json(output)],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      return current ? mapNode(current) : undefined
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
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [runId, nodeName, json(toStoredError(error))],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      return current ? mapNode(current) : undefined
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
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [runId, json(output)],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
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
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [runId, json(toStoredError(error))],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async requestRunCancellation({ runId }) {
      await ready
      const run = await one(db, 'SELECT * FROM workflow_runs WHERE id = $1', [
        runId,
      ])
      if (!run) return undefined
      if (
        isTerminalRunStatus(run.status as StoredRun['status']) ||
        run.status === 'cancelling'
      ) {
        return mapRun(run)
      }
      const row = await one(
        db,
        `
	          UPDATE workflow_runs
	          SET status = 'cancelling',
	              version = version + 1,
	              updated_at = now()
	          WHERE id = $1
	            AND status NOT IN ('cancelling', 'completed', 'failed', 'cancelled')
	          RETURNING *
	        `,
        [runId],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async cancelRun({ runId }) {
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
          SET status = 'cancelled',
              version = version + 1,
              updated_at = now()
          WHERE id = $1
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [runId],
      )
      if (row) return mapRun(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_runs WHERE id = $1',
        [runId],
      )
      return current ? mapRun(current) : undefined
    },
    async cancelNode({ runId, nodeName }) {
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
	          SET status = 'cancelled',
	              version = version + 1,
	              updated_at = now()
	          WHERE run_id = $1 AND name = $2
	            AND status NOT IN ('completed', 'failed', 'cancelled')
	          RETURNING *
	        `,
        [runId, nodeName],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      return current ? mapNode(current) : undefined
    },
    async cancelNonTerminalRunNodes({ runId }) {
      await ready
      const rows = await many(
        db,
        `
	          UPDATE workflow_nodes
	          SET status = 'cancelled',
	              version = version + 1,
	              updated_at = now()
	          WHERE run_id = $1
	            AND status NOT IN ('completed', 'failed', 'cancelled')
	          RETURNING *
	        `,
        [runId],
      )
      return rows.map(mapNode)
    },
    async ensureNodeAttempt(params) {
      await ready
      const key = identityKey(params.identity)
      try {
        return await db.transaction(async (tx) => {
          const node = await one(
            tx,
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

          const existing = await one(
            tx,
            'SELECT * FROM workflow_attempts WHERE identity_key = $1',
            [key],
          )
          if (existing) {
            return { attempt: mapAttempt(existing), created: false }
          }

          const attemptId = id()
          const leaseToken = id()
          const attempt = await one(
            tx,
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
          const updatedNode = await one(
            tx,
            `
              UPDATE workflow_nodes
              SET status = 'waiting',
                  current_attempt_id = $3,
                  attempt_count = attempt_count + 1,
                  version = version + 1,
                  updated_at = now()
              WHERE run_id = $1 AND name = $2
                AND status NOT IN ('completed', 'failed', 'cancelled')
              RETURNING *
            `,
            [params.identity.runId, params.identity.nodeName, attemptId],
          )
          if (!updatedNode) {
            throw new Error(
              `Terminal node [${params.identity.runId}.${params.identity.nodeName}] cannot create attempt`,
            )
          }
          return { attempt: mapAttempt(attempt!), created: true }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await one(
            db,
            'SELECT * FROM workflow_attempts WHERE identity_key = $1',
            [key],
          )
          if (raced) return { attempt: mapAttempt(raced), created: false }
        }
        throw error
      }
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
      const loadExistingChildRun = async (
        connection: WorkflowPostgresConnection,
      ) => {
        const existingLink = await one(
          connection,
          'SELECT * FROM workflow_child_links WHERE identity_key = $1',
          [key],
        )
        if (!existingLink) return undefined
        const childRun = await one(
          connection,
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
      const existing = await loadExistingChildRun(db)
      if (existing) return existing

      try {
        return await db.transaction(async (tx) => {
          const raced = await loadExistingChildRun(tx)
          if (raced) return raced

          const childRun = await createStoredRun(
            tx,
            {
              kind: params.childKind,
              name: params.childName,
              workflowName: params.childName,
              ...(params.childKind === 'task'
                ? { taskName: params.childName }
                : {}),
              input: params.input,
              parentRunId: params.parentRunId,
              parentNodeName: params.parentNodeName,
              rootRunId: params.rootRunId,
              tags: params.tags,
              idempotencyKey: params.idempotencyKey,
            },
            { recoverUniqueViolation: false },
          )
          const link = await one(
            tx,
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
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await loadExistingChildRun(db)
          if (raced) return raced
        }
        throw error
      }
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
      if (isTerminalNodeStatus(node.status as StoredNode['status'])) {
        return mapNode(node)
      }
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
            AND status NOT IN ('completed', 'failed', 'cancelled')
            AND selected_case IS NULL
          RETURNING *
        `,
        [runId, nodeName, caseKey],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      if (!current) return undefined
      if (isTerminalNodeStatus(current.status as StoredNode['status'])) {
        return mapNode(current)
      }
      if (current.selected_case === caseKey) return mapNode(current)
      throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
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

      const loadExistingMapItems = async (
        connection: WorkflowPostgresConnection,
      ) => {
        const existingSet = await one(
          connection,
          `
            SELECT *
            FROM workflow_map_item_sets
            WHERE run_id = $1 AND node_name = $2
          `,
          [params.runId, params.nodeName],
        )
        const existingItems = await many(
          connection,
          `
            SELECT *
            FROM workflow_map_items
            WHERE run_id = $1 AND node_name = $2
            ORDER BY item_index ASC
          `,
          [params.runId, params.nodeName],
        )
        if (!existingSet) return undefined
        const existingKeys = existingSet.keys as readonly (
          | string
          | null
          | undefined
        )[]
        const sameKeys =
          existingKeys.length === keys.length &&
          existingKeys.every(
            (existingKey, index) =>
              (existingKey ?? null) === (keys[index] ?? null),
          )
        if (!sameKeys) throw new Error(`Conflicting map items for [${key}]`)
        const sameItems =
          existingItems.length === params.items.length &&
          existingItems.every((existingItem, index) =>
            sameValue(existingItem.item, params.items[index]),
          )
        if (!sameItems) throw new Error(`Conflicting map items for [${key}]`)
        return { items: existingItems.map(mapMapItem), created: false }
      }
      const existing = await loadExistingMapItems(db)
      if (existing) return existing

      try {
        return await db.transaction(async (tx) => {
          const raced = await loadExistingMapItems(tx)
          if (raced) return raced

          await tx.query(
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
            await tx.query(
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
            tx,
            `
              SELECT *
              FROM workflow_map_items
              WHERE run_id = $1 AND node_name = $2
              ORDER BY item_index ASC
            `,
            [params.runId, params.nodeName],
          )
          return { items: created.map(mapMapItem), created: true }
        })
      } catch (error) {
        if (isUniqueViolation(error)) {
          const raced = await loadExistingMapItems(db)
          if (raced) return raced
        }
        throw error
      }
    },
    async completeMapItem(params) {
      await ready
      const row = await one(
        db,
        `
          UPDATE workflow_map_items
          SET status = 'completed', output = $5::jsonb
          WHERE run_id = $1 AND node_name = $2 AND item_index = $3
            AND item_key IS NOT DISTINCT FROM $4
            AND status NOT IN ('completed', 'failed', 'cancelled')
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
      if (row) return mapMapItem(row)
      const current = await one(
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
      return current ? mapMapItem(current) : undefined
    },
    async failMapItem(params) {
      await ready
      const row = await one(
        db,
        `
          UPDATE workflow_map_items
          SET status = 'failed', error = $5::jsonb
          WHERE run_id = $1 AND node_name = $2 AND item_index = $3
            AND item_key IS NOT DISTINCT FROM $4
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [
          params.runId,
          params.nodeName,
          params.itemIndex,
          params.itemKey ?? null,
          json(toStoredError(params.error)),
        ],
      )
      if (row) return mapMapItem(row)
      const current = await one(
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
      return current ? mapMapItem(current) : undefined
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
            AND status NOT IN ('completed', 'failed', 'cancelled')
          RETURNING *
        `,
        [runId, nodeName],
      )
      if (row) return mapNode(row)
      const current = await one(
        db,
        'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
        [runId, nodeName],
      )
      return current ? mapNode(current) : undefined
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
      await insertContinueCommand(command)
    },
    async enqueueDelayed(command, runAt) {
      await ready
      await insertContinueCommand(command, runAt)
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
    async release(command, options) {
      await ready
      await releaseCommand(command.id, command.leaseToken, options)
    },
  }

  const insertContinueCommand = async (
    command: ContinueRunCommand,
    runAt?: Date,
  ) => {
    await db.query(
      `
        INSERT INTO workflow_commands (
          id, kind, run_id, workflow_name, payload, run_at
        )
        VALUES ($1, 'continue', $2, $3, $4::jsonb, COALESCE($5, now()))
        ON CONFLICT (run_id) WHERE kind = 'continue' AND lease_token IS NULL
        DO UPDATE
        SET run_at = LEAST(workflow_commands.run_at, EXCLUDED.run_at),
            payload = EXCLUDED.payload,
            workflow_name = EXCLUDED.workflow_name
      `,
      [id(), command.runId, command.workflowName, json(command), runAt ?? null],
    )
  }

  const releaseCommand = async (
    commandId: string,
    leaseToken: string,
    options?: { readonly error?: unknown },
  ) => {
    if (options?.error === undefined) {
      await db.query(
        `
          UPDATE workflow_commands
          SET lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              run_at = now() + ($3::int * interval '1 millisecond')
          WHERE id = $1 AND lease_token = $2
        `,
        [commandId, leaseToken, RELEASE_BACKOFF_MS],
      )
      return
    }

    await db.query(
      `
        UPDATE workflow_commands
        SET lease_owner = NULL,
            lease_token = NULL,
            lease_expires_at = NULL,
            delivery_count = delivery_count + 1,
            last_error = $3::jsonb,
            dead_at = CASE
              WHEN delivery_count + 1 >= $4 THEN now()
              ELSE dead_at
            END,
            run_at = now() + (
              LEAST(power(2, delivery_count + 1) * $5, $6)::int
              * interval '1 millisecond'
            )
        WHERE id = $1 AND lease_token = $2
      `,
      [
        commandId,
        leaseToken,
        json(toStoredError(options.error)),
        maxDeliveries,
        RELEASE_BACKOFF_MS,
        MAX_ERROR_BACKOFF_MS,
      ],
    )
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
            AND dead_at IS NULL
            AND ${where}
          ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE workflow_commands
        SET lease_owner = $${params.length + 2},
            lease_token = $${params.length + 3},
            lease_expires_at = now() + ($${params.length + 4}::int * interval '1 millisecond')
        WHERE id = (SELECT id FROM candidate)
        RETURNING *
      `,
      [kind, ...params, workerId, leaseToken, leaseMs],
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
    async dispatchActivity(command: ActivityAttemptCommand, options) {
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
            payload,
            run_at
          )
          SELECT $1, 'activity', $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8, now())
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_commands WHERE attempt_id = $6
          )
        `,
        [
          id(),
          command.runId,
          command.workflowName,
          command.activityName,
          command.nodeName,
          command.attemptId,
          json(command),
          options?.runAt ?? null,
        ],
      )
    },
    async dispatchTask(command: TaskAttemptCommand, options) {
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
            payload,
            run_at
          )
          SELECT $1, 'task', $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8, now())
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_commands WHERE attempt_id = $6
          )
        `,
        [
          id(),
          command.runId,
          command.workflowName,
          command.taskName,
          command.nodeName,
          command.attemptId,
          json(command),
          options?.runAt ?? null,
        ],
      )
    },
    async claimActivity(worker) {
      await ready
      if (worker.workflowNames.length === 0) return null
      if (worker.activityNames?.length === 0) return null
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
    async heartbeat(attempt, leaseMs = 30_000) {
      await ready
      const updated = await one<{ id: string }>(
        db,
        `
          UPDATE workflow_commands
          SET lease_expires_at = now() + ($3::int * interval '1 millisecond')
          WHERE id = $1 AND lease_token = $2
          RETURNING id
        `,
        [attempt.id, attempt.leaseToken, leaseMs],
      )
      if (!updated) throw new Error('Workflow attempt heartbeat lease lost')
    },
    async ack(attempt) {
      await ready
      await ackCommand(attempt.id, attempt.leaseToken)
    },
    async release(attempt, options) {
      await ready
      await releaseCommand(attempt.id, attempt.leaseToken, options)
    },
    async deleteUnclaimed({ runId }) {
      await ready
      const deleted = await many<{ id: string }>(
        db,
        `
	          DELETE FROM workflow_commands
	          WHERE run_id = $1
	            AND kind IN ('activity', 'task')
	            AND lease_token IS NULL
	          RETURNING id
	        `,
        [runId],
      )
      return deleted.length
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
