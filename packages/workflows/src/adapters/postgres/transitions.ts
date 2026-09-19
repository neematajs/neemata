import type {
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from '../../runtime/status.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import type { ChildRow, NodeRow, RunRow } from './rows.ts'
import { WORKFLOW_CANCELLATIONS_CHANNEL } from './constants.ts'
import {
  nodeStatusSourcesSql,
  runStatusSourcesSql,
  statusNotify,
} from './fragments.ts'
import { one } from './query.ts'
import {
  loadChild,
  loadNode,
  loadRun,
  mapNode,
  mapNodeChild,
  mapRun,
} from './rows.ts'

/**
 * Compare-and-set status write. A candidate CTE snapshots the old status (and
 * the family root, for notifications), the UPDATE re-checks that the record is
 * still in a legal source status, and the paired notify CTE fires only when the
 * status actually moved. Losing the guard yields no row; the `*Row` forms hand
 * that miss to the caller, the mapped forms resolve it by re-reading.
 */
type Transition = {
  /** One extra SET assignment, numbered after the key params. */
  readonly set?: string
  /** Params following the key columns. */
  readonly values?: readonly unknown[]
  /** Extra UPDATE guard, e.g. a column that must still be unset. */
  readonly where?: string
  /** Extra candidate guard, narrowing which record may move. */
  readonly on?: string
  /** Allows re-asserting `to` from itself, for data-bearing updates. */
  readonly self?: boolean
  /** Defaults to `<record>_<status>`. */
  readonly event?: string
}

const assignments = (to: string, set: string | undefined) =>
  [
    ...(set ? [set] : []),
    `status = '${to}'`,
    'version = version + 1',
    'updated_at = now()',
  ].join(',\n          ')

export const transitionRunRow = (
  db: WorkflowPostgresConnection,
  runId: string,
  to: RuntimeRunStatus,
  options: Transition & { readonly notifyCancellation?: boolean } = {},
) => {
  const notify = statusNotify(options.event ?? `run_${to}`, 'updated')
  // A worker holding the attempt aborts on the hint instead of waiting out its
  // heartbeat cycle, so the cancellation channel rides the same statement.
  const cancellation = options.notifyCancellation
    ? {
        cte: `,
  cancellation_notified AS (
    SELECT pg_notify('${WORKFLOW_CANCELLATIONS_CHANNEL}', id::text)
    FROM updated
  )`,
        columns: `,
    (SELECT count(*) FROM cancellation_notified) AS cancellation_notified`,
      }
    : { cte: '', columns: '' }

  return one<RunRow>(
    db,
    `
    WITH candidate AS (
      SELECT id, status::text AS old_status
      FROM workflow_runs
      WHERE id = $1
    ),
    updated AS (
      UPDATE workflow_runs
      SET ${assignments(to, options.set)}
      FROM candidate
      WHERE workflow_runs.id = candidate.id
        AND workflow_runs.status IN (${runStatusSourcesSql(to)})
        ${options.where ?? ''}
      RETURNING workflow_runs.*, candidate.old_status
    ),${notify.cte}${cancellation.cte}
    SELECT updated.*${notify.columns}${cancellation.columns}
    FROM updated
  `,
    [runId, ...(options.values ?? [])],
  )
}

export const transitionRun = async (
  db: WorkflowPostgresConnection,
  runId: string,
  to: RuntimeRunStatus,
  options: Transition & { readonly notifyCancellation?: boolean } = {},
) => {
  const row = await transitionRunRow(db, runId, to, options)
  if (row) return mapRun(row)
  const current = await loadRun(db, runId)
  return current ? mapRun(current) : undefined
}

export const transitionNodeRow = (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
  to: RuntimeNodeStatus,
  options: Transition = {},
) => {
  const notify = statusNotify(options.event ?? `node_${to}`, 'updated')
  return one<NodeRow>(
    db,
    `
    WITH candidate AS (
      SELECT n.run_id, n.name, n.status::text AS old_status, r.root_run_id
      FROM workflow_nodes n
      JOIN workflow_runs r ON r.id = n.run_id
      WHERE n.run_id = $1 AND n.name = $2
        ${options.on ?? ''}
    ),
    updated AS (
      UPDATE workflow_nodes
      SET ${assignments(to, options.set)}
      FROM candidate
      WHERE workflow_nodes.run_id = candidate.run_id
        AND workflow_nodes.name = candidate.name
        AND workflow_nodes.status IN (${nodeStatusSourcesSql(to, { self: options.self })})
        ${options.where ?? ''}
      RETURNING workflow_nodes.*, candidate.old_status, candidate.root_run_id
    ),${notify.cte}
    SELECT updated.*${notify.columns}
    FROM updated
  `,
    [runId, nodeName, ...(options.values ?? [])],
  )
}

export const transitionNode = async (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
  to: RuntimeNodeStatus,
  options: Transition = {},
) => {
  const row = await transitionNodeRow(db, runId, nodeName, to, options)
  if (row) return mapNode(row)
  const current = await loadNode(db, runId, nodeName)
  return current ? mapNode(current) : undefined
}

export const transitionChildRow = (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
  childKey: string,
  to: RuntimeNodeStatus,
  options: Transition = {},
) => {
  const notify = statusNotify(options.event ?? `child_${to}`, 'updated')
  return one<ChildRow>(
    db,
    `
    WITH candidate AS (
      SELECT c.run_id, c.node_name, c.child_key,
        c.status::text AS old_status, r.root_run_id
      FROM workflow_node_children c
      JOIN workflow_runs r ON r.id = c.run_id
      WHERE c.run_id = $1 AND c.node_name = $2 AND c.child_key = $3
        ${options.on ?? ''}
    ),
    updated AS (
      UPDATE workflow_node_children
      SET ${assignments(to, options.set)}
      FROM candidate
      WHERE workflow_node_children.run_id = candidate.run_id
        AND workflow_node_children.node_name = candidate.node_name
        AND workflow_node_children.child_key = candidate.child_key
        AND workflow_node_children.status IN (${nodeStatusSourcesSql(to, { self: options.self })})
        ${options.where ?? ''}
      RETURNING workflow_node_children.*, candidate.old_status, candidate.root_run_id
    ),${notify.cte}
    SELECT updated.*${notify.columns}
    FROM updated
  `,
    [runId, nodeName, childKey, ...(options.values ?? [])],
  )
}

export const transitionChild = async (
  db: WorkflowPostgresConnection,
  runId: string,
  nodeName: string,
  childKey: string,
  to: RuntimeNodeStatus,
  options: Transition = {},
) => {
  const row = await transitionChildRow(
    db,
    runId,
    nodeName,
    childKey,
    to,
    options,
  )
  if (row) return mapNodeChild(row)
  const current = await loadChild(db, runId, nodeName, childKey)
  return current ? mapNodeChild(current) : undefined
}
