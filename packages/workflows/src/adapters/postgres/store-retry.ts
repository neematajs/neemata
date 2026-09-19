import type { RetryParams } from '../../runtime/retry-validation.ts'
import type { RunSnapshot, StoredRun } from '../../runtime/state.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import type { AttemptRow, ChildRow, NodeRow, RunRow } from './rows.ts'
import { SELF_CHILD_KEY, TASK_RUN_NODE_NAME } from '../../runtime/child-key.ts'
import { validateFailedRunRetry } from '../../runtime/retry-validation.ts'
import { createAttemptExecutor } from './attempt-executor.ts'
import { createRunCoordinationExecutor } from './commands.ts'
import { TERMINAL_RUN_STATUSES_SQL, statusNotify } from './fragments.ts'
import { isUniqueViolation, jsonRow, jsonRows, many, one } from './query.ts'
import { mapAttempt, mapNode, mapNodeChild, mapRun } from './rows.ts'
import { createPostgresWorkflowChildStore } from './store-children.ts'
import { runConflictError } from './store-runs.ts'

type FamilyRow = RunRow & {
  readonly nodes: unknown
  readonly children: unknown
  readonly attempts: unknown
}

/**
 * Locks the run and its whole family for update, so retries serialize against
 * each other and against terminal cleanup. The partial unique index remains
 * authoritative against concurrent new starts.
 */
const lockFamily = async (
  tx: WorkflowPostgresConnection,
  runId: string,
): Promise<readonly RunSnapshot[]> => {
  await tx.query('SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE', [
    runId,
  ])
  const rows = await many<FamilyRow>(
    tx,
    `
      SELECT r.*,
        COALESCE(
          (SELECT jsonb_agg(n) FROM workflow_nodes n WHERE n.run_id = r.id),
          '[]'::jsonb
        ) AS nodes,
        COALESCE((
          SELECT jsonb_agg(c ORDER BY c.node_name, c.ordinal, c.child_key)
          FROM workflow_node_children c WHERE c.run_id = r.id
        ), '[]'::jsonb) AS children,
        COALESCE(
          (SELECT jsonb_agg(a) FROM workflow_attempts a WHERE a.run_id = r.id),
          '[]'::jsonb
        ) AS attempts
      FROM workflow_runs r
      WHERE r.id = $1 OR r.root_run_id = $1
      ORDER BY r.created_at, r.id
      FOR UPDATE OF r
    `,
    [runId],
  )
  return rows.map((row) => ({
    run: mapRun(row),
    nodes: jsonRows<NodeRow>(row.nodes).map(mapNode),
    children: jsonRows<ChildRow>(row.children).map(mapNodeChild),
    attempts: jsonRows<AttemptRow>(row.attempts).map(mapAttempt),
  }))
}

/** Nothing in the family may be leased, claimed or blocked by a unique holder. */
const assertReopenable = async (
  tx: WorkflowPostgresConnection,
  runIds: readonly string[],
) => {
  const guards = await many<{
    id: string
    busy: boolean
    claimed: boolean
    conflict: unknown
  }>(
    tx,
    `
    SELECT r.id,
      EXISTS (
        SELECT 1 FROM workflow_run_leases l
        WHERE l.run_id = r.id AND l.expires_at > now()
      ) AS busy,
      EXISTS (
        SELECT 1 FROM workflow_commands c
        WHERE c.run_id = r.id AND c.lease_expires_at > now() AND c.dead_at IS NULL
      ) AS claimed,
      (
        SELECT to_jsonb(holder) FROM workflow_runs holder
        WHERE holder.id <> r.id
          AND holder.unique_key = r.unique_key
          AND holder.unique_scope = r.unique_scope
          AND (
            r.unique_scope = 'all'
            OR holder.status NOT IN (${TERMINAL_RUN_STATUSES_SQL})
          )
        LIMIT 1
      ) AS conflict
    FROM workflow_runs r WHERE r.id = ANY($1::uuid[])
  `,
    [runIds],
  )

  for (const guard of guards) {
    if (guard.busy) throw new Error(`Run [${guard.id}] is busy`)
    if (guard.claimed)
      throw new Error(`Run [${guard.id}] has an active attempt`)
    const conflict = jsonRow<RunRow>(guard.conflict)
    if (conflict) throw holderConflict(mapRun(conflict))
  }
}

const holderConflict = (holder: StoredRun) => {
  const { unique } = holder
  if (!unique) return new Error(`Run [${holder.id}] holds no unique key`)
  return runConflictError(holder, unique)
}

/**
 * Requeues the family and clears everything the previous attempt left behind.
 * Completed checkpoints are excluded throughout, so a retry resumes rather
 * than restarts; the child reset reads the pre-update node statuses.
 */
const resetFamily = async (
  tx: WorkflowPostgresConnection,
  runIds: readonly string[],
) => {
  const notify = statusNotify('run_retried', 'reopened')
  const reopened = await many<RunRow>(
    tx,
    `
    WITH candidates AS (
      SELECT id, status::text AS old_status
      FROM workflow_runs WHERE id = ANY($1::uuid[])
    ), reopened AS (
      UPDATE workflow_runs r
      SET status = 'queued', error = NULL, output = NULL,
        active_since = now(), updated_at = now(), version = r.version + 1
      FROM candidates WHERE r.id = candidates.id
      RETURNING r.*, candidates.old_status
    ),${notify.cte}
    SELECT reopened.*${notify.columns} FROM reopened
  `,
    [runIds],
  )

  await tx.query(
    'DELETE FROM workflow_run_leases WHERE run_id = ANY($1::uuid[])',
    [runIds],
  )
  await tx.query(
    `
    DELETE FROM workflow_commands
    WHERE run_id = ANY($1::uuid[]) AND dead_at IS NULL
  `,
    [runIds],
  )
  await tx.query(
    `
    UPDATE workflow_commands SET reaped_at = now()
    WHERE run_id = ANY($1::uuid[]) AND dead_at IS NOT NULL
  `,
    [runIds],
  )
  await tx.query(
    `
    UPDATE workflow_node_children c
    SET status = 'pending', current_attempt_id = NULL,
      error = NULL, output = NULL, updated_at = now(), version = version + 1
    WHERE c.run_id = ANY($1::uuid[]) AND c.status <> 'completed'
      AND EXISTS (
        SELECT 1 FROM workflow_nodes n
        WHERE n.run_id = c.run_id AND n.name = c.node_name
          AND n.status <> 'completed'
      )
  `,
    [runIds],
  )
  await tx.query(
    `
    UPDATE workflow_nodes
    SET status = 'pending', error = NULL, output = NULL,
      updated_at = now(), version = version + 1
    WHERE run_id = ANY($1::uuid[]) AND status <> 'completed'
  `,
    [runIds],
  )

  return reopened
}

/** Puts the reopened root back in flight: a task re-dispatches its own attempt. */
const redispatchRoot = async (
  tx: WorkflowPostgresConnection,
  maxDeliveries: number,
  root: StoredRun,
  snapshot: RunSnapshot | undefined,
) => {
  if (root.kind !== 'task') {
    await createRunCoordinationExecutor({ db: tx, maxDeliveries }).enqueue({
      kind: 'continueRun',
      runId: root.id,
      workflowName: root.workflowName,
    })
    return
  }

  const child = snapshot?.children.find(
    (candidate) =>
      candidate.nodeName === TASK_RUN_NODE_NAME &&
      candidate.childKey === SELF_CHILD_KEY,
  )
  if (!child) throw new Error(`Missing task child for run [${root.id}]`)
  const { attempt } = await createPostgresWorkflowChildStore(
    tx,
  ).ensureChildAttempt({
    runId: root.id,
    nodeName: child.nodeName,
    childKey: child.childKey,
    input: root.input,
  })
  if (!attempt.leaseToken) {
    throw new Error(`Attempt [${attempt.id}] was created without a lease`)
  }
  await createAttemptExecutor({ db: tx, maxDeliveries }).dispatchTask({
    kind: 'taskAttempt',
    runId: root.id,
    workflowName: root.workflowName,
    taskName: root.taskName ?? root.name,
    nodeName: TASK_RUN_NODE_NAME,
    childKey: child.childKey,
    attemptId: attempt.id,
    leaseToken: attempt.leaseToken,
    input: attempt.input,
    ...(attempt.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: attempt.idempotencyKey }),
  })
}

export const reopenFailedRun = async (
  db: WorkflowPostgresConnection,
  params: RetryParams,
  maxDeliveries: number,
): Promise<StoredRun> => {
  try {
    return await db.transaction(async (tx) => {
      const snapshots = await lockFamily(tx, params.runId)
      const reopening = validateFailedRunRetry(snapshots, params)
      const runIds = reopening.map(({ run }) => run.id)
      await assertReopenable(tx, runIds)

      const reopened = await resetFamily(tx, runIds)
      const rootRow = reopened.find((run) => run.id === params.runId)
      if (!rootRow) throw new Error(`Run [${params.runId}] was not reopened`)
      const root = mapRun(rootRow)
      await redispatchRoot(
        tx,
        maxDeliveries,
        root,
        snapshots.find(({ run }) => run.id === root.id),
      )
      return root
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    // The family re-entered a unique scope another run already holds; name it
    // instead of surfacing the raw constraint violation.
    const conflict = await one<RunRow>(
      db,
      `
      SELECT holder.* FROM workflow_runs retried
      JOIN workflow_runs holder ON holder.unique_key = retried.unique_key
        AND holder.unique_scope = retried.unique_scope AND holder.id <> retried.id
      WHERE retried.root_run_id = $1
        AND (
          holder.unique_scope = 'all'
          OR holder.status NOT IN (${TERMINAL_RUN_STATUSES_SQL})
        )
      LIMIT 1
    `,
      [params.runId],
    )
    if (conflict) throw holderConflict(mapRun(conflict))
    throw error
  }
}
