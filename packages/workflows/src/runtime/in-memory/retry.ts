import type { RetryParams } from '../retry-validation.ts'
import type { RunSnapshot, StoredRun } from '../state.ts'
import type { State } from './state.ts'
import { SELF_CHILD_KEY, TASK_RUN_NODE_NAME } from '../child-key.ts'
import { continueRun } from '../commands.ts'
import { WorkflowRunConflictError } from '../errors.ts'
import { valueKey } from '../json.ts'
import { validateFailedRunRetry } from '../retry-validation.ts'
import { commandQueues, dispatchAttempt, enqueueContinue } from './queue.ts'
import { createChildAttempt, uniqueKeys } from './records.ts'
import {
  childMapKey,
  latestAttempt,
  nodeKey,
  runAttempts,
  runChildren,
  runNodes,
} from './state.ts'

/** Atomically reopens the failed frontier of a run family and re-dispatches it. */
export function reopenFailedRun(state: State, params: RetryParams): StoredRun {
  const reopening = validateFailedRunRetry(family(state, params.runId), params)
  for (const { run } of reopening) assertIdle(state, run)

  // No await between validation, reopening and enqueue: observers only see
  // the committed family, and duplicate retries cannot interleave.
  const at = state.now()
  for (const snapshot of reopening) reopen(state, snapshot, at)

  const root = state.runs.get(params.runId)!
  redispatch(state, root)
  return root
}

function family(state: State, runId: string): RunSnapshot[] {
  const snapshots: RunSnapshot[] = []

  for (const run of state.runs.values()) {
    if (run.rootRunId !== runId && run.id !== runId) continue
    snapshots.push({
      run,
      nodes: runNodes(state, run.id),
      children: runChildren(state, run.id).sort(
        (left, right) => left.ordinal - right.ordinal,
      ),
      attempts: runAttempts(state, run.id),
    })
  }

  return snapshots
}

/** A run with a live lease or an unexpired claim is still executing. */
function assertIdle(state: State, run: StoredRun) {
  const at = new Date()
  const lease = state.runLeases.get(run.id)
  if (lease && lease.expiresAt > at) {
    throw new Error(`Run [${run.id}] is busy`)
  }

  for (const claimed of [
    ...state.claimedAttemptCommands.values(),
    ...state.claimedContinueCommands.values(),
  ]) {
    if (claimed.payload.runId === run.id && claimed.leaseExpiresAt > at) {
      throw new Error(`Run [${run.id}] has an active attempt`)
    }
  }

  if (!run.unique) return

  const holder = uniqueKeys(state, run.unique.scope).get(
    valueKey(run.unique.key),
  )
  if (holder && holder !== run.id) {
    throw new WorkflowRunConflictError({
      runId: holder,
      status: state.runs.get(holder)!.status,
      key: run.unique.key,
      scope: run.unique.scope,
    })
  }
}

function reopen(state: State, snapshot: RunSnapshot, at: Date) {
  const { run } = snapshot
  const updated: StoredRun = {
    ...run,
    status: 'queued',
    error: undefined,
    output: undefined,
    activeSince: at,
    updatedAt: at,
    version: run.version + 1,
  }
  state.runs.set(run.id, updated)
  state.runLeases.delete(run.id)

  // Dead commands stay as reaped history; live ones are replaced by the
  // fresh dispatch below.
  for (const queue of commandQueues(state)) {
    for (let index = queue.length - 1; index >= 0; index--) {
      const item = queue[index]!
      if (item.payload.runId !== run.id) continue
      if (item.deadAt) {
        queue[index] = { ...item, reapedAt: at }
      } else {
        queue.splice(index, 1)
      }
    }
  }
  for (const [commandId, claimed] of state.claimedAttemptCommands) {
    if (claimed.payload.runId === run.id) {
      state.claimedAttemptCommands.delete(commandId)
    }
  }
  for (const [commandId, claimed] of state.claimedContinueCommands) {
    if (claimed.payload.runId === run.id) {
      state.claimedContinueCommands.delete(commandId)
    }
  }

  if (run.unique) {
    uniqueKeys(state, run.unique.scope).set(valueKey(run.unique.key), run.id)
  }

  for (const node of snapshot.nodes) {
    if (node.status === 'completed') continue
    state.nodes.set(nodeKey(run.id, node.name), {
      ...node,
      status: 'pending',
      error: undefined,
      output: undefined,
      updatedAt: at,
      version: node.version + 1,
    })
  }

  for (const child of snapshot.children) {
    if (child.status === 'completed') continue
    // A completed node is a checkpoint: its children stay as they settled.
    const node = snapshot.nodes.find(({ name }) => name === child.nodeName)
    if (node?.status === 'completed') continue
    state.children.set(childMapKey(child), {
      ...child,
      currentAttemptId: undefined,
      status: 'pending',
      error: undefined,
      output: undefined,
      updatedAt: at,
      version: child.version + 1,
    })
  }

  state.emitRunEvent(updated)
}

/** Puts the reopened root back on a queue, as its original start did. */
function redispatch(state: State, root: StoredRun) {
  if (root.kind !== 'task') {
    enqueueContinue(state, continueRun(root))
    return
  }

  const child = state.children.get(
    childMapKey({
      runId: root.id,
      nodeName: TASK_RUN_NODE_NAME,
      childKey: SELF_CHILD_KEY,
    }),
  )!
  const previous = latestAttempt(state, child)!
  const attempt = createChildAttempt(
    state,
    child,
    previous.input,
    previous.idempotencyKey,
  )
  dispatchAttempt(state, {
    kind: 'taskAttempt',
    runId: root.id,
    workflowName: root.workflowName,
    taskName: root.taskName ?? root.name,
    nodeName: TASK_RUN_NODE_NAME,
    childKey: child.childKey,
    attemptId: attempt.id,
    leaseToken: attempt.leaseToken!,
    input: attempt.input,
    idempotencyKey: attempt.idempotencyKey,
  })
}
