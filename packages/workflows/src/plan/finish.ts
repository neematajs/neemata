import type { StoredChild, StoredError, StoredRun } from '../model.ts'
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
 * Cancels everything the run still has in flight, and answers whether the
 * child runs it cancels have all ended. A task run is cancelled here; a
 * workflow run is told to cancel and settles in a pass of its own, whose end
 * wakes this run again.
 *
 * What is in flight is read from the nodes that have not ended, so a node
 * ends only with every child of it: while `waits`, one with a child run
 * still ending is `cancelling`, and so is that child. A child is `cancelled`
 * once its run is seen ended, and is read no more; one that never started
 * has no run. A later pass therefore reads the heads of the runs still
 * ending alone, as a pass of a map reads those of its children under way,
 * and the items a map had yet to start are read and cancelled once. A run
 * that does not wait, ending now, has every child and node `cancelled` at
 * once, as no pass of it will read them again.
 */
function stop(draft: Draft, run: StoredRun, waits: boolean): boolean {
  const nodes = draft.nodes(run.id).filter(({ status }) => !isTerminal(status))
  const children = nodes.flatMap(({ name }) => {
    const { active, pending } = draft.work(run.id, name, 'all')
    return [...active, ...pending]
  })

  const reached: StoredChild[] = []
  for (const child of children) {
    // One `cancelling` was stopped by an earlier pass, its attempt with it.
    if (child.status !== 'cancelling') {
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
    }
    if (child.childRunId === undefined || child.cancellation === 'detach') {
      draft.updateChild(child, { status: 'cancelled' })
    } else reached.push(child)
  }
  const ids = reached.map(({ childRunId }) => childRunId!)
  draft.require({ heads: ids })
  draft.require({
    runs: ids.filter((id) => {
      const head = draft.head(id)
      return head?.kind === 'task' && !isTerminal(head.status)
    }),
  })

  const ending = new Set<string>()
  for (const child of reached) {
    const childRun = draft.head(child.childRunId!)
    // A run that is gone has nothing left to stop.
    if (childRun && !isTerminal(childRun.status)) {
      if (childRun.kind === 'task') cancelRun(draft, childRun)
      else {
        if (childRun.status !== 'cancelling') {
          draft.enqueue(
            continueRun(draft.updateRun(childRun, { status: 'cancelling' })),
          )
        }
        if (waits) {
          ending.add(child.nodeName)
          if (child.status !== 'cancelling') {
            draft.updateChild(child, { status: 'cancelling' })
          }
          continue
        }
      }
    }
    draft.updateChild(child, { status: 'cancelled' })
  }

  for (const node of nodes) {
    const status = ending.has(node.name) ? 'cancelling' : 'cancelled'
    if (node.status !== status) draft.updateNodeKeepingInput(node, { status })
  }
  return ending.size === 0
}

/**
 * Cancels everything the run still has in flight, and ends it once the child
 * runs it cancels have ended: until then it stays `cancelling`, so a run that
 * reads `cancelled` has no child run still going but those it detached.
 * Each of them ending wakes it, and that pass comes back here. Runs further
 * down are waited for as each child waits for its own, but for those under a
 * child that `failRun` ended at once.
 */
export function cancelRun(draft: Draft, run: StoredRun): StoredRun {
  if (stop(draft, run, true)) {
    return finishRun(draft, run, { status: 'cancelled' })
  }
  return run.status === 'cancelling'
    ? run
    : draft.updateRun(run, { status: 'cancelling' })
}

/**
 * Ends a run as failed from outside its own work: what it has in flight is
 * cancelled, as nothing will wait for it. Unlike a cancellation it ends at
 * once, with child runs it told to cancel still ending: a run reaped for a
 * command no longer delivered may have no pass left to wait in. A run above
 * it can therefore end before those, `cancelled` included.
 */
export function failRun(
  draft: Draft,
  run: StoredRun,
  error: StoredError,
): StoredRun {
  stop(draft, run, false)
  return finishRun(draft, run, { status: 'failed', error })
}
