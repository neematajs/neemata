import type {
  AttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
} from '../../runtime/commands.ts'
import type { CommandReleaseOptions } from '../../runtime/executors.ts'
import type { StoredError } from '../../runtime/state.ts'
import type { Timestamp } from '../../types/index.ts'
import type { State } from './state.ts'
import {
  COMMAND_LEASE_EXPIRED_ERROR,
  toStoredError,
} from '../../runtime/errors.ts'

export type QueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Timestamp
  readonly deliveryCount: number
  readonly lastError?: StoredError
  readonly deadAt?: Timestamp
  readonly reapedAt?: Timestamp
  readonly createdAt: Timestamp
}

export type InspectQueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Timestamp
}

export type ClaimedQueueItem<T> = QueueItem<T> & {
  readonly leaseToken: string
  readonly leaseExpiresAt: Timestamp
}

const RELEASE_BACKOFF_MS = 50
const UNROUTABLE_BACKOFF_MS = 1_000
const MAX_ERROR_BACKOFF_MS = 300_000

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
    for (
      let candidateIndex = index + 1;
      candidateIndex < queue.length;
      candidateIndex += 1
    ) {
      const candidate = queue[candidateIndex]!
      if (
        candidate.deadAt === undefined &&
        matches(candidate) &&
        compare(candidate, queue[index]!) < 0
      ) {
        index = candidateIndex
      }
    }
  }
  return queue.splice(index, 1)[0]
}

export function compareAttemptCommands(
  left: QueueItem<AttemptCommand>,
  right: QueueItem<AttemptCommand>,
) {
  const byRunAt =
    (left.runAt ?? left.createdAt) - (right.runAt ?? right.createdAt)
  if (byRunAt !== 0) return byRunAt
  const byCreatedAt = left.createdAt - right.createdAt
  if (byCreatedAt !== 0) return byCreatedAt
  return left.id.localeCompare(right.id)
}

export function matchesClaim(
  stored:
    | Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'>
    | undefined,
  claim: Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'>,
) {
  return stored?.leaseToken === claim.leaseToken
}

export function queueItem<T>(
  state: State,
  itemId: string,
  payload: T,
  runAt?: Timestamp,
): QueueItem<T> {
  const { now } = state

  return {
    id: itemId,
    payload,
    ...(runAt === undefined ? {} : { runAt }),
    deliveryCount: 0,
    createdAt: now(),
  }
}

// Shared dead-letter bookkeeping for both failure paths — error releases
// and expired-lease takeovers — so the threshold rule cannot drift.
function countFailedDelivery<T>(
  state: State,
  item: QueueItem<T>,
  error: StoredError,
): Pick<QueueItem<T>, 'deliveryCount' | 'lastError' | 'deadAt'> {
  const { now, maxDeliveries } = state

  const deliveryCount = item.deliveryCount + 1
  return {
    deliveryCount,
    lastError: error,
    ...(deliveryCount >= maxDeliveries ? { deadAt: now() } : {}),
  }
}

export function releaseQueueItem<T>(
  state: State,
  item: QueueItem<T>,
  options?: CommandReleaseOptions,
): QueueItem<T> {
  if (options?.error === undefined && options?.reason === undefined) {
    return {
      ...item,
      runAt: Date.now() + RELEASE_BACKOFF_MS,
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
  return {
    ...item,
    ...counted,
    runAt:
      Date.now() +
      Math.min(
        2 ** counted.deliveryCount * backoffBaseMs,
        MAX_ERROR_BACKOFF_MS,
      ),
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
  const { now } = state

  const date = now()
  for (const [key, item] of claimed) {
    if (item.leaseExpiresAt > date || !eligible(item.payload)) continue
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

export function inspectQueueItem<T>(item: QueueItem<T>): InspectQueueItem<T> {
  return {
    id: item.id,
    payload: item.payload,
    ...(item.runAt === undefined ? {} : { runAt: item.runAt }),
  }
}
