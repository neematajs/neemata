import type {
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from '../../runtime/status.ts'
import {
  TERMINAL_NODE_STATUSES,
  TERMINAL_RUN_STATUSES,
} from '../../runtime/status.ts'
import {
  NODE_TRANSITIONS,
  RUN_TRANSITIONS,
  transitionSources,
} from '../../runtime/transitions.ts'
import { WORKFLOW_RUN_EVENTS_CHANNEL } from './constants.ts'

// Statuses are static enum literals, so inlining them into SQL is safe.
const statusList = (statuses: readonly string[]) =>
  statuses.map((status) => `'${status}'`).join(', ')

export const TERMINAL_RUN_STATUSES_SQL = statusList(TERMINAL_RUN_STATUSES)
export const TERMINAL_NODE_STATUSES_SQL = statusList(TERMINAL_NODE_STATUSES)

export const runStatusSourcesSql = (to: RuntimeRunStatus) =>
  statusList(transitionSources(RUN_TRANSITIONS, to))

/**
 * Legal source statuses for writing `to` on a node or child record; `self`
 * additionally allows the idempotent self-transition for data-bearing
 * updates that re-assert an already-reached status.
 */
export const nodeStatusSourcesSql = (
  to: RuntimeNodeStatus,
  options?: { readonly self?: boolean },
) =>
  statusList([
    ...transitionSources(NODE_TRANSITIONS, to),
    ...(options?.self ? [to] : []),
  ])

/**
 * Nothing is persisted for status changes: the `_events` CTE is a plain
 * projection of the changed rows feeding the pg_notify CTE, so watchers learn
 * the family changed and re-read state. One shape serves run, node, child and
 * attempt transitions alike.
 *
 * `columns` must be projected by the statement: Postgres prunes plain SELECT
 * CTEs that nothing references, so an unprojected pg_notify never fires. The
 * pair is returned together so no call site can emit one without the other.
 */
export const statusNotify = (event: string, source: string) => ({
  cte: `
  ${event}_events AS (
    SELECT root_run_id
    FROM ${source}
    WHERE old_status IS DISTINCT FROM status::text
  ),
  ${event}_notified AS (
    SELECT pg_notify('${WORKFLOW_RUN_EVENTS_CHANNEL}', root_run_id::text)
    FROM ${event}_events
  )`,
  columns: `,\n    (SELECT count(*) FROM ${event}_notified) AS ${event}_notified`,
})
