import type { StoredRun } from '../model.ts'
import type { Plan } from '../store.ts'
import { continueRun, isTerminal } from '../model.ts'
import { planning } from './draft.ts'
import { cancelRun } from './finish.ts'

/**
 * Asks a run to stop. For a workflow run the request is the whole change: the
 * run's next pass cancels what it has in flight, so cancellation needs no
 * code of the run. A task run has no pass to wait for and is cancelled here.
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
