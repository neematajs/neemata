import type { WorkflowStore } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import type { DeadCommandRow } from './rows.ts'
import { DEAD_LEASE_PREFIX, coalesceContinueSql } from './commands.ts'
import { id, isUuid, many, one } from './query.ts'
import { mapDeadCommand } from './rows.ts'

type DeadCommandStore = Pick<
  WorkflowStore,
  | 'listDeadCommands'
  | 'listUnreapedDeadCommands'
  | 'markDeadCommandReaped'
  | 'requeueDeadCommand'
>

export const createDeadCommandStore = (
  db: WorkflowPostgresConnection,
): DeadCommandStore => ({
  async listDeadCommands(params) {
    if (params?.runId !== undefined && !isUuid(params.runId)) return []
    const rows = await many<DeadCommandRow>(
      db,
      `
      SELECT *
      FROM workflow_commands
      WHERE dead_at IS NOT NULL
      ${params?.runId === undefined ? '' : 'AND run_id = $1'}
      ORDER BY dead_at DESC, created_at DESC, id ASC
    `,
      params?.runId === undefined ? [] : [params.runId],
    )
    return rows.map(mapDeadCommand)
  },
  async listUnreapedDeadCommands(params) {
    const values: unknown[] = []
    let idFilter = ''
    if (params?.commandId !== undefined) {
      values.push(params.commandId)
      idFilter = `AND id = $${values.length}`
    }
    let limitSql = ''
    if (params?.limit !== undefined) {
      values.push(params.limit)
      limitSql = `LIMIT $${values.length}`
    }
    const rows = await many<DeadCommandRow>(
      db,
      `
      SELECT *
      FROM workflow_commands
      WHERE dead_at IS NOT NULL
        AND reaped_at IS NULL
        ${idFilter}
      ORDER BY dead_at ASC, created_at ASC, id ASC
      ${limitSql}
    `,
      values,
    )
    return rows.map(mapDeadCommand)
  },
  async markDeadCommandReaped(commandId) {
    await db.query(
      `
      UPDATE workflow_commands
      SET reaped_at = now()
      WHERE id = $1
        AND dead_at IS NOT NULL
        AND reaped_at IS NULL
    `,
      [commandId],
    )
  },
  async requeueDeadCommand(commandId) {
    await db.transaction(async (tx) => {
      const command = await one<{ kind: string }>(
        tx,
        `
        SELECT kind
        FROM workflow_commands
        WHERE id = $1 AND dead_at IS NOT NULL
        FOR UPDATE
      `,
        [commandId],
      )
      if (!command) return

      if (command.kind !== 'continue') {
        await tx.query(
          `
          UPDATE workflow_commands
          SET delivery_count = 0,
              last_error = NULL,
              dead_at = NULL,
              reaped_at = NULL,
              lease_owner = NULL,
              lease_token = NULL,
              lease_expires_at = NULL,
              run_at = now()
          WHERE id = $1 AND dead_at IS NOT NULL
        `,
          [commandId],
        )
        return
      }

      // A dead continuation may share its run with a newer live wake-up.
      // Keep the dead source outside the partial unique index until its
      // requeued copy has inserted or coalesced, then consume the source.
      await tx.query(
        `
        UPDATE workflow_commands
        SET lease_token = COALESCE(lease_token, '${DEAD_LEASE_PREFIX}' || id::text)
        WHERE id = $1 AND dead_at IS NOT NULL
      `,
        [commandId],
      )
      await tx.query(
        coalesceContinueSql({
          source: 'id = $1 AND dead_at IS NOT NULL',
          newId: '$2',
          runAt: 'now()',
          deliveryCount: '0',
          lastError: 'NULL',
        }),
        [commandId, id()],
      )
    })
  },
})
