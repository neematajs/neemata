import type { ContinueRunCommand } from '../../runtime/commands.ts'
import type { RunCoordinationExecutor } from '../../runtime/executors.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { toStoredError } from '../../runtime/errors.ts'
import {
  MAX_ERROR_BACKOFF_MS,
  RELEASE_BACKOFF_MS,
  id,
  json,
  one,
} from './sql.ts'

export type PostgresWorkflowCommandContext = {
  readonly db: WorkflowPostgresConnection
  readonly ready: Promise<void>
  readonly maxDeliveries: number
}

export const createPostgresWorkflowCommandHelpers = (
  ctx: PostgresWorkflowCommandContext,
) => {
  const { db, maxDeliveries } = ctx

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

  return {
    insertContinueCommand,
    releaseCommand,
    claimCommand,
    ackCommand,
  }
}

export const createRunCoordinationExecutor = (
  ctx: PostgresWorkflowCommandContext,
): RunCoordinationExecutor => {
  const { ready } = ctx
  const { insertContinueCommand, releaseCommand, claimCommand, ackCommand } =
    createPostgresWorkflowCommandHelpers(ctx)

  return {
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
}
