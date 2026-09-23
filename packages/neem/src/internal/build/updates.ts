/**
 * Neem's description of one DevEngine update for one worker thread. The
 * compiler maps Rolldown's own type to this at its boundary, so supervision
 * code does not depend on `rolldown/experimental`. A patch carries no code:
 * the compiler has written it to disk before the update is sent, and the
 * thread imports it from there.
 */
export type WorkerUpdate =
  | {
      type: 'Patch'
      filename: string
      seq: number
      changedIds: readonly string[]
    }
  | { type: 'FullReload'; reason?: string }
  | { type: 'Noop' }

// One update per registered patch client (worker thread).
export type WorkerUpdateBatch = readonly {
  clientId: string
  update: WorkerUpdate
}[]
