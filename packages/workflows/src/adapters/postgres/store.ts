import type { RunSnapshot } from '../../runtime/state.ts'
import type { WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { WorkflowRunConflictError } from '../../runtime/errors.ts'
import { validateFailedRunRetry } from '../../runtime/store.ts'
import { createAttemptExecutor } from './executor.ts'
import { createRunCoordinationExecutor } from './queue.ts'
import {
  DEFAULT_MAX_DELIVERIES,
  many,
  one,
  mapRun,
  mapNode,
  mapNodeChild,
  mapAttempt,
  jsonRecordArrayColumn,
  jsonRecordColumn,
  withDateColumns,
  emitStatusChangeNotifySql,
  notifyRunStatusEventColumnsSql,
  isUniqueViolation,
} from './sql.ts'
import { createPostgresWorkflowChildStore } from './store-children.ts'
import { createPostgresWorkflowNodeStore } from './store-nodes.ts'
import {
  createPostgresWorkflowRunStore,
  createStoredRun,
} from './store-runs.ts'

export {
  createStoredRun,
  createStoredRunWithState,
  pruneTerminalRunsInTransaction,
} from './store-runs.ts'

type PostgresWorkflowStoreContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
}

export const createPostgresWorkflowStore = (
  ctx: PostgresWorkflowStoreContext,
): WorkflowStore => {
  const { db, ready } = ctx

  return {
    async reopenFailedRun(params) {
      await ready
      return await db
        .transaction(async (tx) => {
          // Row locks serialize retries and fence terminal cleanup. The partial
          // unique index remains authoritative against concurrent new starts.
          await tx.query(
            'SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE',
            [params.runId],
          )
          const rows = await many(
            tx,
            `
              SELECT r.*,
                COALESCE((SELECT jsonb_agg(n) FROM workflow_nodes n WHERE n.run_id = r.id), '[]'::jsonb) AS nodes,
                COALESCE((
                  SELECT jsonb_agg(c ORDER BY c.node_name, c.ordinal, c.child_key)
                  FROM workflow_node_children c WHERE c.run_id = r.id
                ), '[]'::jsonb) AS children,
                COALESCE((SELECT jsonb_agg(a) FROM workflow_attempts a WHERE a.run_id = r.id), '[]'::jsonb) AS attempts
              FROM workflow_runs r
              WHERE r.id = $1 OR r.root_run_id = $1
              ORDER BY r.created_at, r.id
              FOR UPDATE OF r
            `,
            [params.runId],
          )
          const snapshots: RunSnapshot[] = rows.map((row) => ({
            run: mapRun(row),
            nodes: jsonRecordArrayColumn(row.nodes).map((node) =>
              mapNode(withDateColumns(node, ['created_at', 'updated_at'])),
            ),
            children: jsonRecordArrayColumn(row.children).map((child) =>
              mapNodeChild(
                withDateColumns(child, ['created_at', 'updated_at']),
              ),
            ),
            attempts: jsonRecordArrayColumn(row.attempts).map((attempt) =>
              mapAttempt(
                withDateColumns(attempt, [
                  'dispatched_at',
                  'heartbeat_at',
                  'completed_at',
                ]),
              ),
            ),
          }))
          const reopening = validateFailedRunRetry(snapshots, params)
          const runIds = reopening.map(({ run }) => run.id)
          const guards = await many<{
            id: string
            busy: boolean
            claimed: boolean
            conflict: unknown
          }>(
            tx,
            `
            SELECT r.id,
              EXISTS (SELECT 1 FROM workflow_run_leases l WHERE l.run_id = r.id AND l.expires_at > now()) AS busy,
              EXISTS (SELECT 1 FROM workflow_commands c WHERE c.run_id = r.id AND c.lease_expires_at > now() AND c.dead_at IS NULL) AS claimed,
              (
                SELECT to_jsonb(holder) FROM workflow_runs holder
                WHERE holder.id <> r.id AND holder.unique_key = r.unique_key AND holder.unique_scope = r.unique_scope
                  AND (r.unique_scope = 'all' OR holder.status NOT IN ('completed', 'cancelled', 'failed'))
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
            const conflict = jsonRecordColumn(guard.conflict)
            if (conflict) {
              const holder = mapRun(
                withDateColumns(conflict, [
                  'active_since',
                  'created_at',
                  'updated_at',
                ]),
              )
              throw new WorkflowRunConflictError({
                runId: holder.id,
                status: holder.status,
                key: holder.unique!.key,
                scope: holder.unique!.scope,
              })
            }
          }
          // These writes target different tables (or disjoint live/dead command
          // rows), so they can share one statement. Child reset reads the old
          // node snapshot: completed checkpoints remain excluded throughout.
          const reopened = await many(
            tx,
            `
            WITH candidates AS (
              SELECT id, status::text AS old_status FROM workflow_runs WHERE id = ANY($1::uuid[])
            ), reopened AS (
              UPDATE workflow_runs r SET status = 'queued', error = NULL, output = NULL,
                active_since = now(), updated_at = now(), version = r.version + 1
              FROM candidates WHERE r.id = candidates.id
              RETURNING r.*, candidates.old_status
            ), deleted_leases AS (
              DELETE FROM workflow_run_leases WHERE run_id = ANY($1::uuid[])
            ), deleted_commands AS (
              DELETE FROM workflow_commands WHERE run_id = ANY($1::uuid[]) AND dead_at IS NULL
            ), reaped_commands AS (
              UPDATE workflow_commands SET reaped_at = now() WHERE run_id = ANY($1::uuid[]) AND dead_at IS NOT NULL
            ), reset_nodes AS (
              UPDATE workflow_nodes SET status = 'pending', error = NULL, output = NULL,
                updated_at = now(), version = version + 1
              WHERE run_id = ANY($1::uuid[]) AND status <> 'completed'
            ), reset_children AS (
              UPDATE workflow_node_children c SET status = 'pending', current_attempt_id = NULL,
                error = NULL, output = NULL, updated_at = now(), version = version + 1
              WHERE c.run_id = ANY($1::uuid[]) AND c.status <> 'completed'
                AND EXISTS (SELECT 1 FROM workflow_nodes n WHERE n.run_id = c.run_id AND n.name = c.node_name AND n.status <> 'completed')
            ), ${emitStatusChangeNotifySql('reopened', 'run_retried')}
            SELECT reopened.*${notifyRunStatusEventColumnsSql('run_retried')} FROM reopened
          `,
            [runIds],
          )
          const root = mapRun(reopened.find((run) => run.id === params.runId)!)
          const scoped = createPostgresWorkflowStore({ db: tx, ready })
          const commands = {
            db: tx,
            ready,
            maxDeliveries: DEFAULT_MAX_DELIVERIES,
          }
          if (root.kind === 'task') {
            const snapshot = snapshots.find(({ run }) => run.id === root.id)!
            const child = snapshot.children.find(
              (child) =>
                child.nodeName === '$task' && child.childKey === '$self',
            )!
            const attempt = (
              await scoped.ensureChildAttempt({
                runId: root.id,
                nodeName: child.nodeName,
                childKey: child.childKey,
                input: root.input,
              })
            ).attempt
            const attemptExecutor = createAttemptExecutor(commands)
            await attemptExecutor.dispatchTask({
              kind: 'taskAttempt',
              runId: root.id,
              workflowName: root.workflowName,
              taskName: root.taskName ?? root.name,
              nodeName: '$task',
              childKey: child.childKey,
              attemptId: attempt.id,
              leaseToken: attempt.leaseToken!,
              input: attempt.input,
              idempotencyKey: attempt.idempotencyKey,
            })
          } else {
            const runCoordinationExecutor =
              createRunCoordinationExecutor(commands)
            await runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId: root.id,
              workflowName: root.workflowName,
            })
          }
          return root
        })
        .catch(async (error: unknown) => {
          if (isUniqueViolation(error)) {
            const conflict = await one(
              db,
              `
            SELECT holder.* FROM workflow_runs retried
            JOIN workflow_runs holder ON holder.unique_key = retried.unique_key
              AND holder.unique_scope = retried.unique_scope AND holder.id <> retried.id
            WHERE retried.root_run_id = $1
              AND (holder.unique_scope = 'all' OR holder.status NOT IN ('completed', 'cancelled', 'failed'))
            LIMIT 1
          `,
              [params.runId],
            )
            if (conflict) {
              const holder = mapRun(conflict)
              throw new WorkflowRunConflictError({
                runId: holder.id,
                status: holder.status,
                key: holder.unique!.key,
                scope: holder.unique!.scope,
              })
            }
          }
          throw error
        })
    },
    ...createPostgresWorkflowRunStore({ db, ready }),
    ...createPostgresWorkflowNodeStore({ db, ready }),
    ...createPostgresWorkflowChildStore({ db, ready, createStoredRun }),
  }
}
