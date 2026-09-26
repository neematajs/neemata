import type { WorkflowStore, WriteFence } from '../../runtime/store.ts'
import type { WorkflowPostgresConnection } from './connection.ts'
import { StaleWriteFenceError } from '../../runtime/errors.ts'
import { FENCED_WRITES } from '../../runtime/fence.ts'
import { isUuid, one } from './sql.ts'

type FencedParams = { readonly fence?: WriteFence }

// Scopes merge fences, so a write can carry one with nothing to check.
const activeFence = (fence: WriteFence | undefined) =>
  fence?.runLease === undefined && fence?.attempt === undefined
    ? undefined
    : fence

/**
 * Must run in the transaction that makes the write, before it: the check only
 * holds until that transaction ends.
 */
async function assertWriteFence(
  tx: WorkflowPostgresConnection,
  fence: WriteFence,
): Promise<void> {
  if (fence.runLease) {
    const { runId, leaseToken } = fence.runLease
    if (!isUuid(runId)) throw new StaleWriteFenceError()
    // The share lock lasts until commit, so a takeover, release or retry
    // reopening the run waits for this write instead of slipping in after
    // the check. Expiry is judged by wall clock, as acquireRunLease does.
    const held = await one(
      tx,
      `
        SELECT 1 FROM workflow_run_leases
        WHERE run_id = $1 AND lease_token = $2 AND expires_at > clock_timestamp()
        FOR SHARE
      `,
      [runId, leaseToken],
    )
    if (!held) throw new StaleWriteFenceError()
  }
  if (fence.attempt) {
    const { runId, nodeName, childKey, attemptId } = fence.attempt
    if (!isUuid(runId) || !isUuid(attemptId)) throw new StaleWriteFenceError()
    // Locked, so a retry or reopen replacing the current attempt waits for
    // this write. A cancellation that goes on to lock attempt rows takes them
    // after the child, the reverse of settlement; deadlock detection aborts
    // one side of that rare interleaving, and both sides are redelivered.
    const current = await one(
      tx,
      `
        SELECT 1 FROM workflow_node_children
        WHERE run_id = $1 AND node_name = $2 AND child_key = $3
          AND current_attempt_id = $4
        FOR NO KEY UPDATE
      `,
      [runId, nodeName, childKey, attemptId],
    )
    if (!current) throw new StaleWriteFenceError()
  }
}

/** Runs `write` in one transaction with its fence check, if it has a fence. */
export async function withWriteFenceCheck<Result>(
  db: WorkflowPostgresConnection,
  fence: WriteFence | undefined,
  write: (db: WorkflowPostgresConnection) => Promise<Result>,
): Promise<Result> {
  const active = activeFence(fence)
  if (!active) return write(db)
  return db.transaction(async (tx) => {
    await assertWriteFence(tx, active)
    return write(tx)
  })
}

/**
 * Wraps each fenced write so its check and the unchanged write share one
 * transaction (a savepoint when `db` already is one). `bind` builds the store
 * on that transaction.
 */
export function fenceStoreWrites(
  db: WorkflowPostgresConnection,
  store: WorkflowStore,
  bind: (tx: WorkflowPostgresConnection) => WorkflowStore,
): WorkflowStore {
  const fenced: Record<string, unknown> = { ...store }
  for (const name of FENCED_WRITES) {
    const write = store[name] as (params: FencedParams) => Promise<unknown>
    fenced[name] = ({ fence, ...params }: FencedParams) => {
      const active = activeFence(fence)
      if (!active) return write(params)
      return db.transaction(async (tx) => {
        await assertWriteFence(tx, active)
        const bound = bind(tx)[name] as typeof write
        return bound(params)
      })
    }
  }
  return fenced as WorkflowStore
}
