import type {
  StoredAttempt,
  StoredError,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type {
  AttemptSummary,
  DeadWorkflowCommand,
  NodeChildSummary,
  NodeSummary,
  RunLease,
  RunSummary,
} from '../../runtime/store.ts'
import type { ResolvedRunUnique } from '../../types/index.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { many, one, optional } from './query.ts'

/** pg decodes timestamps to Date; jsonb-aggregated rows carry ISO strings. */
type Timestamp = Date | string

const toDate = (value: Timestamp) =>
  value instanceof Date ? value : new Date(value)

const toOptionalDate = (value: Timestamp | null | undefined) =>
  value === null || value === undefined ? undefined : toDate(value)

type RunBaseRow = {
  readonly id: string
  readonly kind: StoredRun['kind']
  readonly name: string
  readonly workflow_name: string
  readonly task_name: string | null
  readonly status: StoredRun['status']
  readonly error: StoredError | null
  readonly parent_run_id: string | null
  readonly parent_node_name: string | null
  readonly root_run_id: string
  readonly tags: Record<string, string> | null
  readonly idempotency_key: readonly unknown[] | null
  readonly version: number
  readonly active_since: Timestamp
  readonly created_at: Timestamp
  readonly updated_at: Timestamp
}

export type RunRow = RunBaseRow & {
  readonly input: unknown
  readonly output: unknown
  readonly unique_key: readonly unknown[] | null
  readonly unique_scope: ResolvedRunUnique['scope'] | null
  readonly unique_behavior: ResolvedRunUnique['behavior'] | null
}

export type RunSummaryRow = RunBaseRow & {
  readonly nodes_total: number | null
  readonly nodes_completed: number | null
}

type NodeBaseRow = {
  readonly run_id: string
  readonly name: string
  readonly kind: StoredNode['kind']
  readonly status: StoredNode['status']
  readonly error: StoredError | null
  readonly selected_case: string | null
  readonly version: number
  readonly created_at: Timestamp
  readonly updated_at: Timestamp
}

export type NodeRow = NodeBaseRow & {
  readonly input: unknown
  readonly output: unknown
}

type AttemptBaseRow = {
  readonly id: string
  readonly run_id: string
  readonly node_name: string
  readonly child_key: string
  readonly status: StoredAttempt['status']
  readonly worker_id: string | null
  readonly lease_token: string | null
  readonly attempt_number: number
  readonly retry_attempt_number: number
  readonly idempotency_key: readonly unknown[] | null
  readonly error: StoredError | null
  readonly dispatched_at: Timestamp
  readonly heartbeat_at: Timestamp | null
  readonly completed_at: Timestamp | null
}

export type AttemptRow = AttemptBaseRow & {
  readonly input: unknown
  readonly output: unknown
}

type ChildBaseRow = {
  readonly run_id: string
  readonly node_name: string
  readonly child_key: string
  readonly kind: StoredNodeChild['kind']
  readonly status: StoredNodeChild['status']
  readonly ordinal: number
  readonly item_key: string | null
  readonly error: StoredError | null
  readonly child_run_id: string | null
  readonly current_attempt_id: string | null
  readonly attempt_count: number
  readonly version: number
  readonly created_at: Timestamp
  readonly updated_at: Timestamp
}

export type ChildRow = ChildBaseRow & {
  readonly item: unknown
  readonly input: unknown
  readonly output: unknown
}

export type RunLeaseRow = {
  readonly run_id: string
  readonly lease_token: string
  readonly version: number
}

export type DeadCommandRow = {
  readonly id: string
  readonly kind: DeadWorkflowCommand['kind']
  readonly run_id: string
  readonly workflow_name: string | null
  readonly task_name: string | null
  readonly activity_name: string | null
  readonly node_name: string | null
  readonly attempt_id: string | null
  readonly payload: unknown
  readonly delivery_count: number
  readonly last_error: StoredError | null
  readonly dead_at: Timestamp
  readonly created_at: Timestamp
}

const mapRunBase = (row: RunBaseRow) => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  workflowName: row.workflow_name,
  ...optional('taskName', row.task_name),
  status: row.status,
  ...optional('error', row.error),
  ...optional('parentRunId', row.parent_run_id),
  ...optional('parentNodeName', row.parent_node_name),
  rootRunId: row.root_run_id,
  tags: row.tags ?? {},
  ...optional('idempotencyKey', row.idempotency_key),
  version: row.version,
  activeSince: toDate(row.active_since),
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
})

export const mapRun = (row: RunRow): StoredRun => {
  let unique: ResolvedRunUnique | undefined
  if (row.unique_key !== null && row.unique_scope && row.unique_behavior) {
    unique = {
      key: row.unique_key,
      scope: row.unique_scope,
      behavior: row.unique_behavior,
    }
  }

  return {
    ...mapRunBase(row),
    input: row.input,
    ...optional('output', row.output),
    ...optional('unique', unique),
  }
}

export const mapRunSummary = (row: RunSummaryRow): RunSummary => ({
  ...mapRunBase(row),
  nodesTotal: row.nodes_total ?? 0,
  nodesCompleted: row.nodes_completed ?? 0,
})

export const mapNodeSummary = (row: NodeBaseRow): NodeSummary => ({
  runId: row.run_id,
  name: row.name,
  kind: row.kind,
  status: row.status,
  ...optional('error', row.error),
  ...optional('selectedCase', row.selected_case),
  version: row.version,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
})

export const mapNode = (row: NodeRow): StoredNode => ({
  ...mapNodeSummary(row),
  ...optional('input', row.input),
  ...optional('output', row.output),
})

export const mapAttemptSummary = (row: AttemptBaseRow): AttemptSummary => ({
  id: row.id,
  runId: row.run_id,
  nodeName: row.node_name,
  childKey: row.child_key,
  status: row.status,
  ...optional('workerId', row.worker_id),
  ...optional('leaseToken', row.lease_token),
  attemptNumber: row.attempt_number,
  retryAttemptNumber: row.retry_attempt_number,
  ...optional('idempotencyKey', row.idempotency_key),
  ...optional('error', row.error),
  dispatchedAt: toDate(row.dispatched_at),
  ...optional('heartbeatAt', toOptionalDate(row.heartbeat_at)),
  ...optional('completedAt', toOptionalDate(row.completed_at)),
})

export const mapAttempt = (row: AttemptRow): StoredAttempt => ({
  ...mapAttemptSummary(row),
  input: row.input,
  ...optional('output', row.output),
})

export const mapNodeChildSummary = (row: ChildBaseRow): NodeChildSummary => ({
  runId: row.run_id,
  nodeName: row.node_name,
  childKey: row.child_key,
  kind: row.kind,
  status: row.status,
  ordinal: row.ordinal,
  ...optional('itemKey', row.item_key),
  ...optional('error', row.error),
  ...optional('childRunId', row.child_run_id),
  ...optional('currentAttemptId', row.current_attempt_id),
  attemptCount: row.attempt_count,
  version: row.version,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
})

export const mapNodeChild = (row: ChildRow): StoredNodeChild => ({
  ...mapNodeChildSummary(row),
  // Map items always carry a payload, so a JS null here is JSON null (a
  // legitimate item value), not SQL NULL — dropping it would diverge from
  // the in-memory adapter for nullable items.
  ...(row.child_key.startsWith('item:')
    ? { item: row.item }
    : optional('item', row.item)),
  ...optional('input', row.input),
  ...optional('output', row.output),
})

export const mapDeadCommand = (row: DeadCommandRow): DeadWorkflowCommand => ({
  id: row.id,
  kind: row.kind,
  runId: row.run_id,
  ...optional('workflowName', row.workflow_name),
  ...optional('taskName', row.task_name),
  ...optional('activityName', row.activity_name),
  ...optional('nodeName', row.node_name),
  ...optional('attemptId', row.attempt_id),
  payload: row.payload,
  deliveryCount: row.delivery_count,
  ...optional('lastError', row.last_error),
  deadAt: toDate(row.dead_at),
  createdAt: toDate(row.created_at),
})

export const mapRunLease = (row: RunLeaseRow): RunLease => ({
  runId: row.run_id,
  leaseToken: row.lease_token,
  version: row.version,
})

export const loadRun = (db: WorkflowPostgresConnection, runId: string) =>
  one<RunRow>(db, 'SELECT * FROM workflow_runs WHERE id = $1', [runId])

export const loadNode = (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
) =>
  one<NodeRow>(
    db,
    'SELECT * FROM workflow_nodes WHERE run_id = $1 AND name = $2',
    [runId, nodeName],
  )

export const loadChild = (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
  childKey: string,
) =>
  one<ChildRow>(
    db,
    `
      SELECT *
      FROM workflow_node_children
      WHERE run_id = $1 AND node_name = $2 AND child_key = $3
    `,
    [runId, nodeName, childKey],
  )

export const loadOrderedChildren = (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
) =>
  many<ChildRow>(
    db,
    `
      SELECT *
      FROM workflow_node_children
      WHERE run_id = $1 AND node_name = $2
      ORDER BY ordinal ASC, child_key ASC
    `,
    [runId, nodeName],
  )
