import type {
  ActivityAttemptCommand,
  AttemptCommand,
  TaskAttemptCommand,
} from '../../runtime/commands.ts'
import type { AttemptExecutor } from '../../runtime/executors.ts'
import type { StoredRun } from '../../runtime/state.ts'
import type { PostgresWorkflowCommandContext } from './commands.ts'
import { AttemptLeaseLostError } from '../../runtime/errors.ts'
import { DEFAULT_LEASE_MS } from '../../runtime/executors.ts'
import { createPostgresWorkflowCommandHelpers } from './commands.ts'
import { WORKFLOW_COMMANDS_CHANNEL } from './constants.ts'
import { id, json, many, one } from './query.ts'

type DispatchColumn = 'activity_name' | 'task_name'

export const createAttemptExecutor = (
  ctx: PostgresWorkflowCommandContext,
): AttemptExecutor => {
  const { db } = ctx
  const { claimCommand, releaseCommand, ackCommand } =
    createPostgresWorkflowCommandHelpers(ctx)

  /**
   * One attempt command per attempt id: the NOT EXISTS guard makes redispatch
   * after a crash idempotent. The kind and its name column come from a closed
   * two-value union, so interpolating them is safe.
   */
  const insertAttemptCommand = async (
    kind: 'activity' | 'task',
    column: DispatchColumn,
    name: string,
    command: AttemptCommand,
    runAt: Date | undefined,
  ) => {
    await db.query(
      `
      WITH inserted AS (
        INSERT INTO workflow_commands (
          id,
          kind,
          run_id,
          workflow_name,
          ${column},
          node_name,
          attempt_id,
          payload,
          run_at
        )
        SELECT $1, '${kind}', $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8, now())
        WHERE NOT EXISTS (
          SELECT 1 FROM workflow_commands WHERE attempt_id = $6
        )
        RETURNING run_at
      )
      SELECT pg_notify('${WORKFLOW_COMMANDS_CHANNEL}', '${kind}')
      FROM inserted
      WHERE run_at <= now()
    `,
      [
        id(),
        command.runId,
        command.workflowName,
        name,
        command.nodeName,
        command.attemptId,
        json(command),
        runAt ?? null,
      ],
    )
  }

  return {
    dispatchActivity: (command: ActivityAttemptCommand, options) =>
      insertAttemptCommand(
        'activity',
        'activity_name',
        command.activityName,
        command,
        options?.runAt,
      ),
    dispatchTask: (command: TaskAttemptCommand, options) =>
      insertAttemptCommand(
        'task',
        'task_name',
        command.taskName,
        command,
        options?.runAt,
      ),
    async claim(worker) {
      const params: unknown[] = []
      const placeholders = (values: readonly string[]) =>
        values
          .map((value) => {
            params.push(value)
            return `$${params.length}`
          })
          .join(', ')
      const eligible: string[] = []

      if (
        worker.workflowNames.length > 0 &&
        worker.activityNames?.length !== 0
      ) {
        const activity = [
          `kind = 'activity'`,
          `workflow_name IN (${placeholders(worker.workflowNames)})`,
        ]
        if (worker.activityNames !== undefined) {
          activity.push(
            `activity_name IN (${placeholders(worker.activityNames)})`,
          )
        }
        eligible.push(`(${activity.join(' AND ')})`)
      }

      if (worker.taskNames.length > 0) {
        eligible.push(
          `(kind = 'task' AND task_name IN (${placeholders(worker.taskNames)}))`,
        )
      }

      if (eligible.length === 0) return null
      const claimed = await claimCommand(eligible, params, worker)
      if (!claimed) return null
      return {
        id: claimed.id,
        command: claimed.payload as AttemptCommand,
        leaseToken: claimed.lease_token,
      }
    },
    async heartbeat(attempt, leaseMs = DEFAULT_LEASE_MS) {
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
      if (!updated) throw new AttemptLeaseLostError()
      return { runStatus: updated.run_status }
    },
    ack: (attempt) => ackCommand(attempt.id, attempt.leaseToken),
    release: (attempt, options) =>
      releaseCommand(attempt.id, attempt.leaseToken, options),
    async deleteUnclaimed({ runId }) {
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
