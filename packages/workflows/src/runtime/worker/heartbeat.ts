import { createFuture } from '@nmtjs/common'

import type { ClaimedAttempt } from '../commands.ts'
import type { AttemptExecutor } from '../executors.ts'
import type { WorkflowWakeEvents } from '../wake-events.ts'
import { DEFAULT_LEASE_MS } from '../executors.ts'
import { isTerminalRunStatus } from '../status.ts'
import { isAttemptHeartbeatLeaseLost } from './loop.ts'

export type AttemptAbortReasonType =
  | 'timeout'
  | 'leaseLost'
  | 'cancelled'
  | 'shutdown'

/** Identifies the attempt an abort, timeout or cancellation belongs to. */
type AttemptRef = {
  readonly runId: string
  readonly nodeName: string
  readonly attemptId: string
}

/**
 * `lifecycle.signal.reason` handed to handlers. An Error rather than a bare
 * `{ type }` object: libraries that receive the signal reject with its
 * reason, and a plain object there surfaces in logs and crash reports as
 * `[object Object]` with no stack to trace it back.
 */
export class WorkflowAttemptAbortError extends Error {
  readonly type: AttemptAbortReasonType
  readonly runId: string
  readonly nodeName: string
  readonly attemptId: string

  constructor(input: AttemptRef & { readonly type: AttemptAbortReasonType }) {
    super(
      `Workflow attempt [${input.attemptId}] for [${input.runId}.${input.nodeName}] aborted: ${input.type}`,
    )
    this.name = 'WorkflowAttemptAbortError'
    this.type = input.type
    this.runId = input.runId
    this.nodeName = input.nodeName
    this.attemptId = input.attemptId
  }
}

export type AttemptAbortReason = WorkflowAttemptAbortError

export class WorkflowAttemptTimeoutError extends Error {
  readonly runId: string
  readonly nodeName: string
  readonly attemptId: string
  readonly timeoutMs: number

  constructor(input: AttemptRef & { readonly timeoutMs: number }) {
    super(
      `Workflow attempt [${input.attemptId}] for [${input.runId}.${input.nodeName}] timed out after ${input.timeoutMs}ms`,
    )
    this.name = 'WorkflowAttemptTimeoutError'
    this.runId = input.runId
    this.nodeName = input.nodeName
    this.attemptId = input.attemptId
    this.timeoutMs = input.timeoutMs
  }
}

export class WorkflowAttemptCancellationObservedError extends Error {
  constructor(input: AttemptRef) {
    super(
      `Workflow attempt [${input.attemptId}] for [${input.runId}.${input.nodeName}] observed cancellation`,
    )
    this.name = 'WorkflowAttemptCancellationObservedError'
  }
}

export class WorkflowAttemptShutdownError extends Error {
  constructor(input: AttemptRef) {
    super(
      `Workflow attempt [${input.attemptId}] for [${input.runId}.${input.nodeName}] interrupted by worker shutdown`,
    )
    this.name = 'WorkflowAttemptShutdownError'
  }
}

export function isAttemptCancellationObserved(
  error: unknown,
): error is WorkflowAttemptCancellationObservedError {
  return error instanceof WorkflowAttemptCancellationObservedError
}

export function isAttemptShutdown(
  error: unknown,
): error is WorkflowAttemptShutdownError {
  return error instanceof WorkflowAttemptShutdownError
}

export async function runWithAttemptHeartbeat<T>(
  input: {
    readonly attemptExecutor: AttemptExecutor
    readonly claimed: ClaimedAttempt
    readonly leaseMs?: number
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
    readonly wakeEvents?: Pick<WorkflowWakeEvents, 'onCancellation'>
  },
  handler: (lifecycle: { readonly signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const { runId, nodeName, attemptId } = input.claimed.command
  const ref: AttemptRef = { runId, nodeName, attemptId }
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
  const attemptAbort = new AbortController()
  const abortAttempt = (type: AttemptAbortReasonType) => {
    if (attemptAbort.signal.aborted) return
    attemptAbort.abort(new WorkflowAttemptAbortError({ ...ref, type }))
  }
  let heartbeatRunning = false
  let heartbeatFailed = false
  const heartbeatFailure = createFuture<never>()
  let beatPending = false
  const beat = () => {
    if (heartbeatRunning || heartbeatFailed) return
    heartbeatRunning = true
    void input.attemptExecutor
      .heartbeat(input.claimed, leaseMs)
      .then(({ runStatus }) => {
        if (runStatus !== 'cancelling' && !isTerminalRunStatus(runStatus))
          return
        heartbeatFailed = true
        abortAttempt('cancelled')
        heartbeatFailure.reject(
          new WorkflowAttemptCancellationObservedError(ref),
        )
      })
      .catch((error: unknown) => {
        if (!isAttemptHeartbeatLeaseLost(error)) return
        heartbeatFailed = true
        abortAttempt('leaseLost')
        heartbeatFailure.reject(error)
      })
      .finally(() => {
        heartbeatRunning = false
        if (beatPending) {
          beatPending = false
          beat()
        }
      })
  }
  const interval = setInterval(beat, intervalMs)
  // Cancellation wake hint: run the heartbeat check immediately instead of
  // waiting out the interval. The DB read stays authoritative — a spurious
  // notification just costs one extra heartbeat query. A wake arriving while
  // a heartbeat is in flight is latched: that snapshot may predate the
  // cancellation commit, so a follow-up check must run once it settles.
  const unsubscribeCancellationWake = input.wakeEvents?.onCancellation(
    runId,
    () => {
      if (heartbeatRunning) {
        beatPending = true
        return
      }
      beat()
    },
  )
  const { timeoutMs } = input
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutFailure =
    timeoutMs === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            abortAttempt('timeout')
            reject(new WorkflowAttemptTimeoutError({ ...ref, timeoutMs }))
          }, timeoutMs)
        })
  let removeShutdownListener: (() => void) | undefined
  const shutdownSignal = input.signal
  const shutdownFailure =
    shutdownSignal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          const shutdown = () => {
            abortAttempt('shutdown')
            reject(new WorkflowAttemptShutdownError(ref))
          }
          if (shutdownSignal.aborted) {
            shutdown()
            return
          }
          shutdownSignal.addEventListener('abort', shutdown, { once: true })
          removeShutdownListener = () =>
            shutdownSignal.removeEventListener('abort', shutdown)
        })

  try {
    const work = handler({ signal: attemptAbort.signal })
    work.catch(() => {})
    const races = [work, heartbeatFailure.promise]
    if (timeoutFailure !== undefined) races.push(timeoutFailure)
    if (shutdownFailure !== undefined) races.push(shutdownFailure)
    return await Promise.race(races)
  } finally {
    clearInterval(interval)
    unsubscribeCancellationWake?.()
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
    removeShutdownListener?.()
  }
}
