import type { StoredError, StoredRun } from '../model.ts'
import type { Draft } from './draft.ts'
import { continueRun, isTerminal } from '../model.ts'
import { uniqueKey } from './keys.ts'

/**
 * Queues a pass for the parent, which reads this run's outcome there. The
 * parent is not read: a wake carries no outcome, so one that comes late or
 * twice decides nothing, and its route is the parent's for good. Nor can the
 * parent be gone, as a family is removed whole and this run is loaded.
 */
export function wakeParent(draft: Draft, run: StoredRun) {
  const { parentRunId, parentRoute } = run
  if (parentRunId === undefined) return
  if (parentRoute === undefined) {
    throw new Error(`Run [${run.id}] has a parent and no parent route`)
  }
  draft.enqueue(continueRun({ id: parentRunId, ...parentRoute }))
}

/** Ends a run: its outcome, the key it no longer holds, and its parent's wake. */
export function finishRun(
  draft: Draft,
  run: StoredRun,
  outcome: Pick<StoredRun, 'status'> &
    Partial<Pick<StoredRun, 'output' | 'error'>>,
) {
  const finished = draft.updateRun(run, outcome)
  // An `all` key outlives the run: it promises the key is never used again.
  if (run.unique?.scope === 'active') {
    draft.release(uniqueKey(run.unique), run.id)
  }
  wakeParent(draft, finished)
  return finished
}

/**
 * Cancels everything the run still has in flight. Child runs are stopped in
 * the same commit, so the run never ends with a child nobody will stop: a
 * workflow is told to cancel and settles in a pass of its own, a task run has
 * no pass and is cancelled here.
 */
function stop(draft: Draft, run: StoredRun) {
  const { nodes, children } = draft.records(run.id)!
  const stopped = children.flatMap(({ status, childRunId, cancellation }) =>
    isTerminal(status) || childRunId === undefined || cancellation === 'detach'
      ? []
      : [childRunId],
  )
  draft.require({ heads: stopped })
  draft.require({
    runs: stopped.filter((id) => draft.head(id)?.kind === 'task'),
  })

  for (const node of nodes) {
    if (!isTerminal(node.status))
      draft.updateNode(node, { status: 'cancelled' })
  }
  for (const child of children) {
    if (isTerminal(child.status)) continue
    draft.updateChild(child, { status: 'cancelled' })

    const attempt =
      child.currentAttemptId === undefined
        ? undefined
        : draft.attempt(run.id, child.currentAttemptId)
    if (attempt?.status === 'started') {
      draft.updateAttempt(attempt, {
        status: 'cancelled',
        completedAt: draft.now,
      })
    }

    if (child.childRunId === undefined || child.cancellation === 'detach') {
      continue
    }
    const childRun = draft.head(child.childRunId)
    if (
      !childRun ||
      isTerminal(childRun.status) ||
      childRun.status === 'cancelling'
    ) {
      continue
    }
    if (childRun.kind === 'task') cancelRun(draft, childRun)
    else {
      draft.enqueue(
        continueRun(draft.updateRun(childRun, { status: 'cancelling' })),
      )
    }
  }
}

/** Cancels everything the run still has in flight and ends it. */
export function cancelRun(draft: Draft, run: StoredRun): StoredRun {
  stop(draft, run)
  return finishRun(draft, run, { status: 'cancelled' })
}

/**
 * Ends a run as failed from outside its own work: what it has in flight is
 * cancelled, as nothing will wait for it.
 */
export function failRun(
  draft: Draft,
  run: StoredRun,
  error: StoredError,
): StoredRun {
  stop(draft, run)
  return finishRun(draft, run, { status: 'failed', error })
}
