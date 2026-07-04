import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  TaskAttemptCommand,
} from '../../runtime/commands.ts'
import type { AttemptExecutor } from '../../runtime/executors.ts'
import type { StoredRun } from '../../runtime/state.ts'
import type { PostgresWorkflowCommandContext } from './queue.ts'
import { createPostgresWorkflowCommandHelpers } from './queue.ts'
import { id, json, many, one } from './sql.ts'

export const createAttemptExecutor = (
  ctx: PostgresWorkflowCommandContext,
): AttemptExecutor => {
  const { db, ready } = ctx
  const { claimCommand, releaseCommand, ackCommand } =
    createPostgresWorkflowCommandHelpers(ctx)

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

  return {
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
}
