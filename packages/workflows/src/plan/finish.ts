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
 * How a run is stopped. A run that `waits` ends once what it stops has; one
 * that does not ends now, failed from outside its own work. The runs `quiet`
 * have nothing claimed, as read once they were seen `cancelling`: no handler
 * of an attempt of theirs is running, nor can one begin.
 */
type Stopping = {
  readonly waits: boolean
  readonly quiet?: ReadonlySet<string>
}

/**
 * Cancels everything the run still has in flight, and answers whether all of
 * it has ended. A task run is cancelled here; a workflow run is told to
 * cancel and settles in a pass of its own, whose end wakes this run again.
 *
 * What is in flight is read from the nodes that have not ended, so a node
 * ends only with every child of it: while the run `waits`, one with work
 * still ending is `cancelling`, and so is that child. A child's work is its
 * run, or its attempt, whose handler may be running until it is seen to have
 * stopped (`retire`) or the run is `quiet`. A child is `cancelled` once its
 * work has ended, and is read no more; one that never started has none. A
 * later pass therefore reads the heads of the runs still ending alone, as a
 * pass of a map reads those of its children under way, and the items a map
 * had yet to start are read and cancelled once. Nor is an attempt read while
 * it is only waited for. A run that does not wait, ending now, has every
 * child and node `cancelled` at once, as no pass of it will read them again.
 */
function stop(
  draft: Draft,
  run: StoredRun,
  { waits, quiet }: Stopping,
): { readonly ended: boolean; readonly tasks: readonly StoredRun[] } {
  const nodes = draft.nodes(run.id).filter(({ status }) => !isTerminal(status))
  const children = nodes.flatMap(({ name }) => {
    const { active, pending } = draft.work(run.id, name, 'all')
    return [...active, ...pending]
  })

  const ending = new Set<string>()
  const wait = (child: StoredChild) => {
    ending.add(child.nodeName)
    if (child.status !== 'cancelling') {
      draft.updateChild(child, { status: 'cancelling' })
    }
  }
  // Whether a handler of this run's attempts may still be running.
  const running = waits && !quiet?.has(run.id)

  const reached: StoredChild[] = []
  for (const child of children) {
    if (child.childRunId !== undefined && child.cancellation !== 'detach') {
      reached.push(child)
      continue
    }
    // An attempt is out from when its child starts until it settles it.
    if (child.currentAttemptId !== undefined && child.status !== 'pending') {
      if (running) {
        wait(child)
        continue
      }
      const attempt = draft.attempt(run.id, child.currentAttemptId)
      if (attempt?.status === 'started') {
        draft.updateAttempt(attempt, {
          status: 'cancelled',
          completedAt: draft.now,
        })
      }
    }
    draft.updateChild(child, { status: 'cancelled' })
  }
  const ids = reached.map(({ childRunId }) => childRunId!)
  draft.require({ heads: ids })
  draft.require({
    runs: ids.filter((id) => {
      const head = draft.head(id)
      return head?.kind === 'task' && !isTerminal(head.status)
    }),
  })

  // The task runs it cancels that wait for their handlers.
  const tasks: StoredRun[] = []
  for (const child of reached) {
    const childRun = draft.head(child.childRunId!)
    // A run that is gone has nothing left to stop.
    if (childRun && !isTerminal(childRun.status)) {
      let stopping = childRun
      if (childRun.kind === 'task') {
        stopping = cancelRun(draft, childRun, quiet)
        if (!isTerminal(stopping.status)) tasks.push(stopping)
      } else if (childRun.status !== 'cancelling') {
        stopping = draft.updateRun(childRun, { status: 'cancelling' })
        draft.enqueue(continueRun(stopping))
      }
      // Each child run that ends wakes this run, whose pass comes back here.
      if (waits && !isTerminal(stopping.status)) {
        wait(child)
        continue
      }
    }
    draft.updateChild(child, { status: 'cancelled' })
  }

  for (const node of nodes) {
    const status = ending.has(node.name) ? 'cancelling' : 'cancelled'
    if (node.status !== status) draft.updateNodeKeepingInput(node, { status })
  }
  return { ended: ending.size === 0, tasks }
}

/**
 * Cancels everything the run still has in flight, and ends it once all of it
 * has ended: until then it stays `cancelling`, and keeps its unique key, so a
 * run that reads `cancelled` has no child run still going but those it
 * detached, and no handler of its attempts still running. Each child run
 * ending wakes it, as does each attempt retired, and that pass comes back
 * here. Runs further down are waited for as each child waits for its own,
 * but for those under a child that `failRun` ended at once.
 *
 * The runs `quiet` are known to have no handler running (`planDrain`).
 */
export function cancelRun(
  draft: Draft,
  run: StoredRun,
  quiet?: ReadonlySet<string>,
): StoredRun {
  if (stop(draft, run, { waits: true, ...(quiet ? { quiet } : {}) }).ended) {
    return finishRun(draft, run, { status: 'cancelled' })
  }
  return run.status === 'cancelling'
    ? run
    : draft.updateRun(run, { status: 'cancelling' })
}

/**
 * What of a run left `cancelling` nothing but a drain may end: the run, when
 * it waits for attempts of its own, and the task runs under it still being
 * cancelled. An attempt whose handler stops is ended by its delivery, but
 * one whose command waits unclaimed, or is never claimed, has no delivery to
 * end it. A child workflow run is not among them: its own passes drain it.
 * Nor is the run for its task runs alone: a drain reads a run whole, and the
 * end of each task run wakes it anyway.
 *
 * Read from what `cancelRun` read, as it left it; empty when nothing waits.
 */
export function draining(draft: Draft, run: StoredRun): StoredRun[] {
  if (run.status !== 'cancelling') return []
  let attempts = false
  const tasks: StoredRun[] = []
  for (const node of draft.nodes(run.id)) {
    if (node.status !== 'cancelling') continue
    for (const child of draft.work(run.id, node.name, 'all').active) {
      if (child.status !== 'cancelling') continue
      if (child.childRunId === undefined) attempts = true
      else {
        const head = draft.head(child.childRunId)
        if (head?.kind === 'task' && head.status === 'cancelling') {
          tasks.push(head)
        }
      }
    }
  }
  return attempts ? [run, ...tasks] : tasks
}

/**
 * Ends a run as failed from outside its own work: what it has in flight is
 * cancelled, as nothing will wait for it. Unlike a cancellation it ends at
 * once, with child runs it told to cancel, and handlers of its attempts,
 * still ending: a run reaped for a command no longer delivered may have no
 * pass left to wait in. A run above it can therefore end before those,
 * `cancelled` included.
 */
export function failRun(
  draft: Draft,
  run: StoredRun,
  error: StoredError,
): Failed {
  const { tasks } = stop(draft, run, { waits: false })
  return { run: finishRun(draft, run, { status: 'failed', error }), tasks }
}

export type Failed = {
  readonly run: StoredRun
  /**
   * The task runs it cancelled that wait for their handlers: nothing of the
   * failed run waits for them, so a drain is what may end each.
   */
  readonly tasks: readonly StoredRun[]
}
