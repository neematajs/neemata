import type {
  DurationString,
  RetryPolicy,
  StoredChild,
  StoredNode,
  StoredRun,
} from '../model.ts'
import type { Plan } from '../store.ts'
import type { Draft } from './draft.ts'
import {
  RunConflict,
  RunNotFailed,
  RunNotFound,
  RunNotRoot,
  StaleRunVersion,
} from '../errors.ts'
import { continueRun, SELF, TASK } from '../model.ts'
import { planning, Refused } from './draft.ts'
import { uniqueKey } from './keys.ts'

export type RetryError =
  | RunConflict
  | RunNotFailed
  | RunNotFound
  | RunNotRoot
  | StaleRunVersion

/** Why a run cannot be retried in place, from its record alone. */
export function unretryable(
  runId: string,
  run: StoredRun | undefined,
  expectedVersion: number | undefined,
): Exclude<RetryError, RunConflict> | undefined {
  if (!run) return new RunNotFound({ runId })
  if (run.parentRunId !== undefined) return new RunNotRoot({ runId })
  const { status, version } = run
  if (status !== 'failed') return new RunNotFailed({ runId, status })
  if (expectedVersion !== undefined && expectedVersion !== version) {
    return new StaleRunVersion({ runId, expectedVersion, version })
  }
  return undefined
}

/** A record as it is reopened: what it came to is forgotten. */
function cleared<Record extends object>(record: Record): Record {
  const {
    error: _error,
    output: _output,
    ...rest
  } = record as Record & { readonly error?: unknown; readonly output?: unknown }
  return rest as Record
}

/**
 * Starts another attempt of a child whose attempts all ended, on the input
 * the last one had. The attempt is the first of a new budget and keeps its
 * place in the child's history.
 */
export function reattempt(draft: Draft, child: StoredChild) {
  const previous = draft.attempt(child.runId, child.currentAttemptId!)!
  const { runId, nodeName, childKey } = child
  const attempt = draft.createAttempt({
    id: draft.id('attempt'),
    runId,
    nodeName,
    childKey,
    attemptNumber: child.attemptCount + 1,
    retryAttemptNumber: 1,
    input: previous.input,
  })
  draft.updateChild(cleared(child), {
    status: 'running',
    currentAttemptId: attempt.id,
    attemptCount: child.attemptCount + 1,
  })
  return attempt
}

/**
 * Makes a run that ended without completing active again, as the same run.
 * A workflow run is only marked and woken: its next pass reopens what it
 * owns, so a family is reopened one run per commit, never all at once. A
 * task run is its one chain of attempts, which gets another here.
 */
export function reopenRun(
  draft: Draft,
  run: StoredRun,
  /** A parent step's overrides of a task's own limits. */
  limits: {
    readonly retry?: RetryPolicy
    readonly timeout?: DurationString
  } = {},
): StoredRun {
  const reopened = draft.updateRun(cleared(run), {
    status: 'queued',
    // The run's timeout counts from here.
    activeSince: draft.now,
  })
  if (run.kind === 'workflow') {
    draft.enqueue(continueRun(reopened))
    return reopened
  }

  const { id: runId, name, revision } = run
  const { retry, timeout } = limits
  // Has the run loaded with what it owns, when only its record was: its
  // node and its attempts are what a task run is reopened through.
  draft.records(runId)
  const node = draft.node(runId, TASK)!
  const attempt = reattempt(draft, draft.child(runId, TASK, SELF)!)
  draft.updateNode(cleared(node), { status: 'running' })
  draft.enqueue({
    kind: 'runTask',
    name,
    ...(revision === undefined ? {} : { revision }),
    runId,
    nodeName: TASK,
    childKey: SELF,
    attemptId: attempt.id,
    input: attempt.input,
    ...(retry === undefined ? {} : { retry }),
    ...(timeout === undefined ? {} : { timeout }),
  })
  return reopened
}

/**
 * Reopens what a workflow run owns and did not complete, before the pass that
 * found the run reopened advances it. Completed nodes stay as they are; in
 * the others, completed children stay and the rest wait to be started again.
 */
export function reopenWork(draft: Draft, run: StoredRun) {
  // A run that starts owns no node yet, and one whose nodes all completed
  // has nothing to reopen: neither is read whole, as every first pass would
  // be planned twice for it. Of a run opened, every node is known.
  if (draft.nodes(run.id).every(({ status }) => status === 'completed')) return
  const { nodes, children } = draft.records(run.id)!
  const reopen = (node: StoredNode) => {
    const own = children.filter(({ nodeName }) => nodeName === node.name)
    for (const child of own) {
      if (child.status !== 'completed') {
        draft.updateChild(cleared(child), { status: 'pending' })
      }
    }
    // Without a child the node never opened: what it is computed from, its
    // input, its case or its items, failed and is computed again.
    draft.updateNode(cleared(node), {
      status: own.length > 0 ? 'running' : 'pending',
    })
  }
  for (const node of nodes) if (node.status !== 'completed') reopen(node)
}

/**
 * Reopens a failed root run in place: same id, input, tags and keys, with
 * everything it completed kept. Only the root is written here; each run under
 * it is reopened by the pass of its parent that reaches it.
 */
export function planRetry(
  runId: string,
  expectedVersion?: number,
): Plan<StoredRun, RetryError> {
  return planning<StoredRun, RetryError>((draft) => {
    const run = draft.records(runId)?.run
    const refusal = unretryable(runId, run, expectedVersion)
    if (refusal) return new Refused(refusal)

    const { unique } = run!
    if (unique) {
      // An `active` key was given up when the run failed. Whoever took it
      // since keeps it, whatever the constraint says about joining: a retry
      // is this run again, never another.
      const key = uniqueKey(unique)
      const holderId = draft.holder(key)
      const holder =
        holderId === undefined || holderId === runId
          ? undefined
          : draft.head(holderId)
      if (holder) {
        const { id, status } = holder
        return new Refused(
          new RunConflict({
            runId: id,
            status,
            key: unique.key,
            scope: unique.scope,
          }),
        )
      }
      if (holderId !== runId) draft.acquire(key, runId)
    }

    return reopenRun(draft, run!)
  })
}
