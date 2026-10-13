import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  TaskAttemptCommand,
} from '../../runtime/commands.ts'
import type { AttemptExecutor } from '../../runtime/executors.ts'
import type { StoredRun } from '../../runtime/state.ts'
import type { PostgresWorkflowCommandContext } from './queue.ts'
import { DEFAULT_LEASE_MS } from '../../runtime/executors.ts'
import { withWriteFenceCheck } from './fence.ts'
import { createPostgresWorkflowCommandHelpers, routesSql } from './queue.ts'
import {
  WORKFLOW_COMMANDS_CHANNEL,
  id,
  json,
  many,
  one,
  timestampParam,
} from './sql.ts'

export const createAttemptExecutor = (
  ctx: PostgresWorkflowCommandContext,
): AttemptExecutor => {
  const { db, ready } = ctx
  const { claimCommand, releaseCommand, ackCommand } =
    createPostgresWorkflowCommandHelpers(ctx)

  const claimAttempt = async (
    where: string | readonly string[],
    params: unknown[],
    workerId: string,
    leaseMs: number,
  ): Promise<ClaimedAttempt | null> => {
    const claimed = await claimCommand(where, params, workerId, leaseMs)
    if (!claimed) return null
    return {
      id: claimed.id as string,
      command: claimed.payload as AttemptCommand,
      leaseToken: claimed.lease_token as string,
    }
  }

  return {
    async dispatchActivity(command: ActivityAttemptCommand, options) {
      await ready
      await db.query(
        `
        WITH inserted AS (
          INSERT INTO workflow_commands (
            id,
            kind,
            run_id,
            workflow_name,
            revision,
            activity_name,
            node_name,
            attempt_id,
            payload,
            run_at
          )
          SELECT $1, 'activity', $2, $3, $9, $4, $5, $6, $7::jsonb, COALESCE($8, now())
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_commands WHERE attempt_id = $6
          )
          RETURNING run_at
        )
        SELECT pg_notify('${WORKFLOW_COMMANDS_CHANNEL}', 'activity')
        FROM inserted
        WHERE run_at <= now()
      `,
        [
          id(),
          command.runId,
          command.workflowName,
          command.activityName,
          command.nodeName,
          command.attemptId,
          json(command),
          timestampParam(options?.runAt),
          command.revision ?? null,
        ],
      )
    },
    async dispatchTask(command: TaskAttemptCommand, options) {
      await ready
      await db.query(
        `
        WITH inserted AS (
          INSERT INTO workflow_commands (
            id,
            kind,
            run_id,
            workflow_name,
            revision,
            task_name,
            node_name,
            attempt_id,
            payload,
            run_at
          )
          SELECT $1, 'task', $2, $3, $9, $4, $5, $6, $7::jsonb, COALESCE($8, now())
          WHERE NOT EXISTS (
            SELECT 1 FROM workflow_commands WHERE attempt_id = $6
          )
          RETURNING run_at
        )
        SELECT pg_notify('${WORKFLOW_COMMANDS_CHANNEL}', 'task')
        FROM inserted
        WHERE run_at <= now()
      `,
        [
          id(),
          command.runId,
          command.workflowName,
          command.taskName,
          command.nodeName,
          command.attemptId,
          json(command),
          timestampParam(options?.runAt),
          command.revision ?? null,
        ],
      )
    },
    async claim(worker) {
      await ready
      const params: unknown[] = []
      const eligible: string[] = []

      // An activity runs under its workflow run's revision, so its route is
      // the workflow's; an empty activity filter serves no activity at all.
      const workflows =
        worker.activityNames?.length === 0
          ? undefined
          : routesSql('workflow_name', worker.workflows, params)
      if (workflows !== undefined) {
        const activity = [`kind = 'activity'`, workflows]
        if (worker.activityNames !== undefined) {
          const names = worker.activityNames.map((name) => {
            params.push(name)
            return `$${params.length}`
          })
          activity.push(`activity_name IN (${names.join(', ')})`)
        }
        eligible.push(`(${activity.join(' AND ')})`)
      }

      const tasks = routesSql('task_name', worker.tasks, params)
      if (tasks !== undefined) eligible.push(`(kind = 'task' AND ${tasks})`)

      if (eligible.length === 0) return null
      return claimAttempt(eligible, params, worker.workerId, worker.leaseMs)
    },
    async heartbeat(attempt, leaseMs = DEFAULT_LEASE_MS) {
      await ready
      const updated = await one<{
        id: string
        run_status: StoredRun['status']
      }>(
        db,
        `
        UPDATE workflow_commands c
        SET lease_expires_at = now() + ($3::int * interval '1 millisecond')
        WHERE c.id = $1 AND c.lease_token = $2
        RETURNING c.id,
          (SELECT r.status FROM workflow_runs r WHERE r.id = c.run_id) AS run_status
      `,
        [attempt.id, attempt.leaseToken, leaseMs],
      )
      if (!updated) throw new Error('Workflow attempt heartbeat lease lost')
      return { runStatus: updated.run_status }
    },
    async ack(attempt) {
      await ready
      await ackCommand(attempt.id, attempt.leaseToken)
    },
    async release(attempt, options) {
      await ready
      await releaseCommand(attempt.id, attempt.leaseToken, options)
    },
    async deleteUnclaimed({ runId, fence }) {
      await ready
      const deleted = await withWriteFenceCheck(db, fence, (tx) =>
        many<{ id: string }>(
          tx,
          `
            DELETE FROM workflow_commands
            WHERE run_id = $1
              AND kind IN ('activity', 'task')
              AND lease_token IS NULL
            RETURNING id
          `,
          [runId],
        ),
      )
      return deleted.length
    },
  }
}
