import { randomUUID } from 'node:crypto'

import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredError,
  StoredRun,
} from '../../runtime/state.ts'
import type {
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from '../../runtime/status.ts'
import type {
  CreateRunInput,
  AttemptSummary,
  DeadWorkflowCommand,
  NodeChildSummary,
  NodeSummary,
  PruneTerminalRunsParams,
  RunSummary,
  TerminalRunStatus,
} from '../../runtime/store.ts'
import type { ResolvedRunUnique } from '../../types/index.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import {
  NODE_TRANSITIONS,
  RUN_TRANSITIONS,
  transitionSources,
} from '../../runtime/transitions.ts'

export type JsonRecord = Record<string, unknown>

export const RELEASE_BACKOFF_MS = 50
export const UNROUTABLE_BACKOFF_MS = 1_000
export const MAX_ERROR_BACKOFF_MS = 300_000
export const DEFAULT_MAX_DELIVERIES = 20
export const DEFAULT_PRUNE_BATCH_SIZE = 100
export const DEFAULT_PRUNE_STATUSES = [
  'completed',
  'cancelled',
  'failed',
] as const satisfies readonly TerminalRunStatus[]

export const TASK_RUN_NODE_NAME = '$task'
// LISTEN/NOTIFY wake-up hint channels; payloads are the command kind and the
// run id respectively. Delivery is best-effort — polling remains the fallback.
export const WORKFLOW_COMMANDS_CHANNEL = 'workflow_commands'
export const WORKFLOW_CANCELLATIONS_CHANNEL = 'workflow_run_cancellations'
export const WORKFLOW_RUN_EVENTS_CHANNEL = 'workflow_run_events'
export const id = () => randomUUID()
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const isUuid = (value: string) => uuidPattern.test(value)
let lastTimestamp = 0
export const now = () => {
  const current = Date.now()
  lastTimestamp = Math.max(current, lastTimestamp + 1)
  return new Date(lastTimestamp)
}
export const json = (value: unknown) => JSON.stringify(value)
export const fromOptional = (value: unknown) =>
  value === null ? undefined : value
export const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
export const sameValue = (left: unknown, right: unknown): boolean => {
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
export const sameOptionalValue = (left: unknown, right: unknown) =>
  left === undefined && right === undefined
    ? true
    : left !== undefined && right !== undefined && sameValue(left, right)
export const normalizePruneBatchSize = (batchSize: number | undefined) => {
  if (batchSize === undefined) return DEFAULT_PRUNE_BATCH_SIZE
  if (!Number.isInteger(batchSize) || batchSize < 1) return 0
  return batchSize
}
export const normalizePruneStatuses = (
  statuses: PruneTerminalRunsParams['statuses'],
): readonly TerminalRunStatus[] => [
  ...new Set(
    (statuses ?? DEFAULT_PRUNE_STATUSES).filter((status) =>
      DEFAULT_PRUNE_STATUSES.includes(status),
    ),
  ),
]
export const isUniqueViolation = (error: unknown) =>
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

// Statuses are static enum literals, so inlining them into SQL is safe.
export const runStatusSourcesSql = (to: RuntimeRunStatus) =>
  transitionSources(RUN_TRANSITIONS, to)
    .map((status) => `'${status}'`)
    .join(', ')

/**
 * Legal source statuses for writing `to` on a node or child record; `self`
 * additionally allows the idempotent self-transition for data-bearing
 * updates that re-assert an already-reached status.
 */
export const nodeStatusSourcesSql = (
  to: RuntimeNodeStatus,
  options?: { readonly self?: boolean },
) =>
  [...transitionSources(NODE_TRANSITIONS, to), ...(options?.self ? [to] : [])]
    .map((status) => `'${status}'`)
    .join(', ')

export const optional = <K extends string, V>(
  key: K,
  value: V | null | undefined,
) =>
  value === undefined || value === null
    ? ({} as Partial<Record<K, V>>)
    : ({ [key]: value } as Record<K, V>)

export const runnableName = (input: CreateRunInput) =>
  input.name ?? input.taskName ?? input.workflowName

export const mapRun = (row: JsonRecord): StoredRun => ({
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
  ...(fromOptional(row.unique_key) === undefined
    ? {}
    : {
        unique: {
          key: row.unique_key as readonly unknown[],
          scope: row.unique_scope as ResolvedRunUnique['scope'],
          behavior: row.unique_behavior as ResolvedRunUnique['behavior'],
        },
      }),
  version: row.version as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

export const mapRunSummary = (row: JsonRecord): RunSummary => ({
  id: row.id as string,
  kind: row.kind as RunSummary['kind'],
  name: row.name as string,
  workflowName: row.workflow_name as string,
  ...optional('taskName', row.task_name as string | undefined),
  status: row.status as RunSummary['status'],
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
  nodesTotal: Number(row.nodes_total ?? 0),
  nodesCompleted: Number(row.nodes_completed ?? 0),
})

export const mapNode = (row: JsonRecord): StoredNode => ({
  runId: row.run_id as string,
  name: row.name as string,
  kind: row.kind as StoredNode['kind'],
  status: row.status as StoredNode['status'],
  ...optional('input', fromOptional(row.input)),
  ...optional('output', fromOptional(row.output)),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  ...optional('selectedCase', row.selected_case as string | undefined),
  version: row.version as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

export const mapNodeSummary = (row: JsonRecord): NodeSummary => ({
  runId: row.run_id as string,
  name: row.name as string,
  kind: row.kind as NodeSummary['kind'],
  status: row.status as NodeSummary['status'],
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  ...optional('selectedCase', row.selected_case as string | undefined),
  version: row.version as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

export const mapAttempt = (row: JsonRecord): StoredAttempt => ({
  id: row.id as string,
  runId: row.run_id as string,
  nodeName: row.node_name as string,
  childKey: row.child_key as string,
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

export const mapAttemptSummary = (row: JsonRecord): AttemptSummary => ({
  id: row.id as string,
  runId: row.run_id as string,
  nodeName: row.node_name as string,
  childKey: row.child_key as string,
  status: row.status as AttemptSummary['status'],
  ...optional('workerId', row.worker_id as string | undefined),
  ...optional('leaseToken', row.lease_token as string | undefined),
  attemptNumber: row.attempt_number as number,
  ...optional(
    'idempotencyKey',
    fromOptional(row.idempotency_key) as readonly unknown[] | undefined,
  ),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  dispatchedAt: row.dispatched_at as Date,
  ...optional('heartbeatAt', row.heartbeat_at as Date | undefined),
  ...optional('completedAt', row.completed_at as Date | undefined),
})

export const mapNodeChild = (row: JsonRecord): StoredNodeChild => ({
  runId: row.run_id as string,
  nodeName: row.node_name as string,
  childKey: row.child_key as string,
  kind: row.kind as StoredNodeChild['kind'],
  status: row.status as StoredNodeChild['status'],
  ordinal: row.ordinal as number,
  ...optional('itemKey', row.item_key as string | undefined),
  // Map items always carry a payload, so a JS null here is JSON null (a
  // legitimate item value), not SQL NULL — dropping it would diverge from
  // the in-memory adapter for nullable items.
  ...((row.child_key as string).startsWith('item:')
    ? { item: row.item }
    : optional('item', fromOptional(row.item))),
  ...optional('input', fromOptional(row.input)),
  ...optional('output', fromOptional(row.output)),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  ...optional('childRunId', row.child_run_id as string | undefined),
  ...optional('currentAttemptId', row.current_attempt_id as string | undefined),
  attemptCount: row.attempt_count as number,
  version: row.version as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

export const mapNodeChildSummary = (row: JsonRecord): NodeChildSummary => ({
  runId: row.run_id as string,
  nodeName: row.node_name as string,
  childKey: row.child_key as string,
  kind: row.kind as NodeChildSummary['kind'],
  status: row.status as NodeChildSummary['status'],
  ordinal: row.ordinal as number,
  ...optional('itemKey', row.item_key as string | undefined),
  ...optional('error', fromOptional(row.error) as StoredError | undefined),
  ...optional('childRunId', row.child_run_id as string | undefined),
  ...optional('currentAttemptId', row.current_attempt_id as string | undefined),
  attemptCount: row.attempt_count as number,
  version: row.version as number,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

export const mapDeadCommand = (row: JsonRecord): DeadWorkflowCommand => ({
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

export const notifyRunStatusEventSql = (cteName: string) => `
  ${cteName}_notified AS (
    SELECT pg_notify('${WORKFLOW_RUN_EVENTS_CHANNEL}', root_run_id::text)
    FROM ${cteName}_events
  )
`

// Postgres prunes plain SELECT CTEs that are not referenced from projected
// output, so pg_notify counts must be output columns for notifications to fire.
export const notifyRunStatusEventColumnsSql = (
  ...cteNames: readonly string[]
) =>
  cteNames
    .map(
      (name) =>
        `,\n    (SELECT count(*) FROM ${name}_notified) AS ${name}_notified`,
    )
    .join('')

// Nothing is persisted for status changes: the `_events` CTE is a plain
// projection of the changed rows feeding the pg_notify CTE, so watchers
// learn the family changed and re-read state. One shape serves run, node,
// child, and attempt transitions alike.
export const emitStatusChangeNotifySql = (
  sourceAlias: string,
  cteName: string,
) => `
  ${cteName}_events AS (
    SELECT root_run_id
    FROM ${sourceAlias}
    WHERE old_status IS DISTINCT FROM status::text
  ),
  ${notifyRunStatusEventSql(cteName)}
`

export const parseJsonColumn = (value: unknown): unknown =>
  typeof value === 'string' ? JSON.parse(value) : value

export const jsonRecordColumn = (value: unknown): JsonRecord | undefined => {
  const parsed = parseJsonColumn(value)
  return isRecord(parsed) ? parsed : undefined
}

export const jsonRecordArrayColumn = (value: unknown): JsonRecord[] => {
  const parsed = parseJsonColumn(value)
  return Array.isArray(parsed) ? parsed.filter(isRecord) : []
}

export const dateColumn = (value: unknown): unknown =>
  value instanceof Date
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : value

export const withDateColumns = (
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

export const one = async <T extends JsonRecord>(
  db: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) => {
  const result = await db.query<T>(sql, params)
  return result.rows[0]
}

export const many = async <T extends JsonRecord>(
  db: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) => (await db.query<T>(sql, params)).rows
