import type {
  AttemptCommand,
  ContinueRunCommand,
  WorkflowCommand,
} from '../commands.ts'
import type { CommandReleaseOptions } from '../executors.ts'
import type { StoredError } from '../state.ts'
import type { DeadWorkflowCommand } from '../store.ts'
import type { ClaimedQueueItem, QueueItem, State } from './state.ts'
import { COMMAND_LEASE_EXPIRED_ERROR, toStoredError } from '../errors.ts'

const RELEASE_BACKOFF_MS = 50
const UNROUTABLE_BACKOFF_MS = 1_000
const MAX_ERROR_BACKOFF_MS = 300_000

export function queueItem<T>(
  state: State,
  id: string,
  payload: T,
  runAt?: Date,
): QueueItem<T> {
  return {
    id,
    payload,
    ...(runAt === undefined ? {} : { runAt }),
    deliveryCount: 0,
    createdAt: state.now(),
  }
}

export function removeWhere<T>(
  queue: T[],
  match: (item: T) => boolean,
): number {
  let removed = 0

  for (let index = queue.length - 1; index >= 0; index--) {
    if (!match(queue[index]!)) continue
    queue.splice(index, 1)
    removed++
  }

  return removed
}

export function claimQueued<T>(
  queue: QueueItem<T>[],
  matches: (item: QueueItem<T>) => boolean,
  compare?: (left: QueueItem<T>, right: QueueItem<T>) => number,
): QueueItem<T> | undefined {
  let index = queue.findIndex(
    (item) => item.deadAt === undefined && matches(item),
  )
  if (index === -1) return undefined

  if (compare) {
    for (const [candidateIndex, candidate] of queue.entries()) {
      if (candidateIndex <= index) continue
      if (candidate.deadAt !== undefined || !matches(candidate)) continue
      if (compare(candidate, queue[index]!) < 0) index = candidateIndex
    }
  }

  return queue.splice(index, 1)[0]
}

export function compareAttemptCommands(
  left: QueueItem<AttemptCommand>,
  right: QueueItem<AttemptCommand>,
): number {
  const byRunAt =
    (left.runAt ?? left.createdAt).getTime() -
    (right.runAt ?? right.createdAt).getTime()
  if (byRunAt !== 0) return byRunAt
  const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime()
  if (byCreatedAt !== 0) return byCreatedAt
  return left.id.localeCompare(right.id)
}

/** Index of the live (not dead-lettered) continue command for a run. */
export function liveContinueIndex(
  state: State,
  runId: string,
  skipIndex = -1,
): number {
  return state.continueCommands.findIndex(
    (item, index) =>
      index !== skipIndex &&
      item.deadAt === undefined &&
      item.payload.runId === runId,
  )
}

export function enqueueContinue(
  state: State,
  command: ContinueRunCommand,
  runAt?: Date,
) {
  // Dead items must not absorb fresh enqueues — a dead-lettered continue
  // command would otherwise silently swallow every later wake-up for its
  // run. Mirrors postgres, where claim-time dead rows keep their lease
  // token and therefore stay outside the continue-dedup partial index.
  const index = liveContinueIndex(state, command.runId)
  if (index === -1) {
    state.continueCommands.push(
      queueItem(state, state.newId('continue'), command, runAt),
    )
  } else {
    const existing = state.continueCommands[index]!
    state.continueCommands[index] = {
      ...existing,
      payload: command,
      runAt: earliestRunAt(existing.runAt, runAt),
    }
  }

  if (runAt === undefined || runAt <= new Date()) {
    state.fire(state.commandWakeListeners.get('continue'))
  }
}

/** Merges a released or requeued command into the run's live command. */
export function absorbContinue(
  state: State,
  item: QueueItem<ContinueRunCommand>,
) {
  const index = liveContinueIndex(state, item.payload.runId)
  if (index === -1) {
    state.continueCommands.push(item)
    return
  }

  state.continueCommands[index] = mergeContinue(
    state.continueCommands[index]!,
    item,
  )
}

export function mergeContinue(
  pending: QueueItem<ContinueRunCommand>,
  released: QueueItem<ContinueRunCommand>,
): QueueItem<ContinueRunCommand> {
  const lastError =
    released.deliveryCount > pending.deliveryCount
      ? released.lastError
      : pending.lastError
  const { lastError: _lastError, ...withoutError } = pending

  return {
    ...withoutError,
    runAt: earliestRunAt(pending.runAt, released.runAt),
    deliveryCount: Math.max(pending.deliveryCount, released.deliveryCount),
    ...(lastError === undefined ? {} : { lastError }),
  }
}

export function attemptCommandExists(state: State, attemptId: string): boolean {
  if (
    state.attemptCommands.some((item) => item.payload.attemptId === attemptId)
  ) {
    return true
  }

  for (const item of state.claimedAttemptCommands.values()) {
    if (item.payload.attemptId === attemptId) return true
  }

  return false
}

export function dispatchAttempt(
  state: State,
  command: AttemptCommand,
  runAt?: Date,
) {
  if (attemptCommandExists(state, command.attemptId)) return

  const kind = command.kind === 'taskAttempt' ? 'task' : 'activity'
  state.attemptCommands.push(
    queueItem(state, state.newId(`${kind}-command`), command, runAt),
  )
  if (runAt === undefined || runAt <= new Date()) {
    state.fire(state.commandWakeListeners.get(kind))
  }
}

/**
 * Backoff deadlines are wall-clock: the monotonic `now()` runs ahead of real
 * time under bursts, and a redelivery must wait the real interval.
 */
export function releaseQueueItem<T>(
  state: State,
  item: QueueItem<T>,
  options?: CommandReleaseOptions,
): QueueItem<T> {
  if (options?.error === undefined && options?.reason === undefined) {
    return {
      ...item,
      runAt: new Date(Date.now() + RELEASE_BACKOFF_MS),
    }
  }

  // Unroutable commands back off slower than transient errors: nothing can
  // execute them until a deploy changes the registry, but they must still
  // count toward dead-lettering instead of looping forever.
  const backoffBaseMs =
    options.reason === 'unroutable' ? UNROUTABLE_BACKOFF_MS : RELEASE_BACKOFF_MS
  const error =
    options.error ??
    new Error('No implementation can execute this workflow command')
  const counted = countFailedDelivery(state, item, toStoredError(error))
  const backoffMs = Math.min(
    2 ** counted.deliveryCount * backoffBaseMs,
    MAX_ERROR_BACKOFF_MS,
  )

  return {
    ...item,
    ...counted,
    runAt: new Date(Date.now() + backoffMs),
  }
}

// Shared dead-letter bookkeeping for both failure paths — error releases
// and expired-lease takeovers — so the threshold rule cannot drift.
function countFailedDelivery<T>(
  state: State,
  item: QueueItem<T>,
  error: StoredError,
): Pick<QueueItem<T>, 'deliveryCount' | 'lastError' | 'deadAt'> {
  const deliveryCount = item.deliveryCount + 1

  return {
    deliveryCount,
    lastError: error,
    ...(deliveryCount >= state.maxDeliveries ? { deadAt: state.now() } : {}),
  }
}

// Mirrors the postgres claim-time takeover: an expired lease means the
// delivery died without any release (the only failure release-time counting
// can never see), so requeueing must count it — otherwise a poison command
// whose processing kills the claimer crash-loops with deliveryCount stuck
// at 0 and deadAt unreachable. At the threshold the item dead-letters
// instead of becoming claimable again. Only leases the polling worker is
// eligible to redeliver are reclaimed — in postgres the takeover happens
// inside the eligible claim itself, and an unrelated worker must not
// revoke (or dead-letter) work it cannot execute while the original
// claimer may still finish and ack.
export function reclaimExpiredLeases<T>(
  state: State,
  claimed: Map<string, ClaimedQueueItem<T>>,
  queue: QueueItem<T>[],
  eligible: (payload: T) => boolean,
) {
  const at = state.now()

  for (const [key, item] of claimed) {
    if (item.leaseExpiresAt > at || !eligible(item.payload)) continue
    claimed.delete(key)
    const { leaseToken: _token, leaseExpiresAt: _expires, ...released } = item
    // A real error from a prior release beats the synthetic lease message
    // as dead-letter diagnostics, so the takeover only fills a gap.
    queue.push({
      ...released,
      ...countFailedDelivery(
        state,
        item,
        item.lastError ?? COMMAND_LEASE_EXPIRED_ERROR,
      ),
    })
  }
}

/** Both queues, for sweeps that do not care about the command kind. */
export function commandQueues(state: State): QueueItem<WorkflowCommand>[][] {
  return [state.continueCommands, state.attemptCommands]
}

/** Every queued command, whatever its kind, in queue order. */
export function* queuedCommands(
  state: State,
): Generator<QueueItem<WorkflowCommand>> {
  yield* state.continueCommands
  yield* state.attemptCommands
}

export function toDeadCommand(
  item: QueueItem<WorkflowCommand>,
): DeadWorkflowCommand | undefined {
  const { deadAt, payload } = item
  if (deadAt === undefined) return undefined

  const command = {
    id: item.id,
    runId: payload.runId,
    workflowName: payload.workflowName,
    payload,
    deliveryCount: item.deliveryCount,
    ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
    deadAt,
    createdAt: item.createdAt,
  }

  switch (payload.kind) {
    case 'continueRun':
      return { ...command, kind: 'continue' }
    case 'activityAttempt':
      return {
        ...command,
        kind: 'activity',
        activityName: payload.activityName,
        nodeName: payload.nodeName,
        attemptId: payload.attemptId,
      }
    case 'taskAttempt':
      return {
        ...command,
        kind: 'task',
        taskName: payload.taskName,
        nodeName: payload.nodeName,
        attemptId: payload.attemptId,
      }
  }
}

export function findDeadIndex<T>(
  queue: QueueItem<T>[],
  commandId: string,
): number {
  return queue.findIndex(
    (item) => item.id === commandId && item.deadAt !== undefined,
  )
}

/** Strips the dead-letter bookkeeping so the command becomes claimable again. */
export function revive<T>(item: QueueItem<T>): QueueItem<T> {
  return {
    id: item.id,
    payload: item.payload,
    deliveryCount: 0,
    createdAt: item.createdAt,
  }
}

export function inspectQueueItem<T>(item: QueueItem<T>) {
  return {
    id: item.id,
    payload: item.payload,
    ...(item.runAt === undefined ? {} : { runAt: item.runAt }),
  }
}

function earliestRunAt(left: Date | undefined, right: Date | undefined) {
  if (left === undefined || right === undefined) return undefined
  return left <= right ? left : right
}
