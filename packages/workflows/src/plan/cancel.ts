import type { StoredRun } from '../model.ts'
import type { Plan } from '../store.ts'
import { continueRun, isTerminal } from '../model.ts'
import { planning } from './draft.ts'
import { cancelRun } from './finish.ts'

/**
 * Asks a run to stop. For a workflow run the request is the whole change: the
 * run's next pass cancels what it has in flight, so cancellation needs no
 * code of the run. A task run has no pass to wait for and is cancelled here,
 * to end once its handler is seen to have stopped (`planDrain`, `retire`).
 */
export function planCancel(runId: string): Plan<StoredRun | undefined> {
  return planning<StoredRun | undefined>((draft) => {
    const run = draft.records(runId)?.run
    if (!run || isTerminal(run.status) || run.status === 'cancelling') {
      return run
    }
    if (run.kind === 'task') return cancelRun(draft, run)

    const cancelling = draft.updateRun(run, { status: 'cancelling' })
    draft.enqueue(continueRun(cancelling))
    return cancelling
  })
}

/**
 * Goes on with the cancellation of the runs `seen`, nothing of which is
 * claimed, as read once each was seen `cancelling` at its version. No attempt
 * of a run that is cancelling begins, so none of their handlers is running
 * then, nor will be: the attempts each waits for end at once, and so do the
 * task runs under one among them. A run changed since it was seen is left to
 * whatever changed it. Answers the runs as the drain left them.
 */
export function planDrain(
  seen: readonly Pick<StoredRun, 'id' | 'version'>[],
): Plan<readonly StoredRun[]> {
  return planning<readonly StoredRun[]>((draft) => {
    const quiet = new Set(
      seen.flatMap(({ id, version }) => {
        const run = draft.records(id)?.run
        return run?.status === 'cancelling' && run.version === version
          ? [id]
          : []
      }),
    )
    // A task run may have ended with the run above it, earlier in the list.
    return seen.flatMap(({ id }) => {
      const run = draft.head(id)
      if (!run) return []
      return quiet.has(id) && run.status === 'cancelling'
        ? [cancelRun(draft, run, quiet)]
        : [run]
    })
  })
}
