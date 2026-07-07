import type { ClaimedAttempt } from '../commands.ts'
import type { AttemptExecutor } from '../executors.ts'
import type { WorkflowWakeEvents } from '../wake-events.ts'
import { isTerminalRunStatus } from '../status.ts'
import { DEFAULT_LEASE_MS, isAttemptHeartbeatLeaseLost } from './loop.ts'

export type AttemptAbortReason =
  | { readonly type: 'timeout' }
  | { readonly type: 'leaseLost' }
  | { readonly type: 'cancelled' }
  | { readonly type: 'shutdown' }

export class WorkflowAttemptTimeoutError extends Error {
  readonly runId: string
  readonly nodeName: string
  readonly attemptId: string
  readonly timeoutMs: number

  constructor(input: {
    readonly runId: string
    readonly nodeName: string
    readonly attemptId: string
    readonly timeoutMs: number
  }) {
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
  constructor(input: {
    readonly runId: string
    readonly nodeName: string
    readonly attemptId: string
  }) {
    super(
      `Workflow attempt [${input.attemptId}] for [${input.runId}.${input.nodeName}] observed cancellation`,
    )
    this.name = 'WorkflowAttemptCancellationObservedError'
  }
}

export class WorkflowAttemptShutdownError extends Error {
  constructor(input: {
    readonly runId: string
    readonly nodeName: string
    readonly attemptId: string
  }) {
    super(
      `Workflow attempt [${input.attemptId}] for [${input.runId}.${input.nodeName}] interrupted by worker shutdown`,
    )
    this.name = 'WorkflowAttemptShutdownError'
  }
}

export function isAttemptCancellationObserved(error: unknown): boolean {
  return error instanceof WorkflowAttemptCancellationObservedError
}

export function isAttemptShutdown(error: unknown): boolean {
  return error instanceof WorkflowAttemptShutdownError
}

export async function runWithAttemptHeartbeat<T>(
  input: {
    readonly attemptExecutor: AttemptExecutor
    readonly claimed: ClaimedAttempt
    readonly leaseMs?: number
    readonly signal?: AbortSignal
    readonly wakeEvents?: Pick<WorkflowWakeEvents, 'onCancellation'>
  },
  handler: (lifecycle: { readonly signal: AbortSignal }) => Promise<T>,
  timeout?: {
    readonly timeoutMs: number
    readonly createError: () => Error
  },
): Promise<T> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
  const attemptAbort = new AbortController()
  const abortAttempt = (reason: AttemptAbortReason) => {
    if (!attemptAbort.signal.aborted) attemptAbort.abort(reason)
  }
  let heartbeatRunning = false
  let heartbeatFailed = false
  let rejectHeartbeat: (error: unknown) => void = () => {}
  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeat = reject
  })
  const beat = () => {
    if (heartbeatRunning || heartbeatFailed) return
    heartbeatRunning = true
    void input.attemptExecutor
      .heartbeat(input.claimed, leaseMs)
      .then(({ runStatus }) => {
        if (runStatus !== 'cancelling' && !isTerminalRunStatus(runStatus))
          return
        heartbeatFailed = true
        abortAttempt({ type: 'cancelled' })
        rejectHeartbeat(
          new WorkflowAttemptCancellationObservedError({
            runId: input.claimed.command.runId,
            nodeName: input.claimed.command.nodeName,
            attemptId: input.claimed.command.attemptId,
          }),
        )
      })
      .catch((error: unknown) => {
        if (!isAttemptHeartbeatLeaseLost(error)) return
        heartbeatFailed = true
        abortAttempt({ type: 'leaseLost' })
        rejectHeartbeat(error)
      })
      .finally(() => {
        heartbeatRunning = false
      })
  }
  const interval = setInterval(beat, intervalMs)
  // Cancellation wake hint: run the heartbeat check immediately instead of
  // waiting out the interval. The DB read stays authoritative — a spurious
  // notification just costs one extra heartbeat query.
  const unsubscribeCancellationWake = input.wakeEvents?.onCancellation(
    input.claimed.command.runId,
    beat,
  )
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutFailure =
    timeout === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(() => {
            const error = timeout.createError()
            abortAttempt({ type: 'timeout' })
            reject(error)
          }, timeout.timeoutMs)
        })
  let removeShutdownListener: (() => void) | undefined
  const shutdownSignal = input.signal
  const shutdownFailure =
    shutdownSignal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          const shutdown = () => {
            abortAttempt({ type: 'shutdown' })
            reject(
              new WorkflowAttemptShutdownError({
                runId: input.claimed.command.runId,
                nodeName: input.claimed.command.nodeName,
                attemptId: input.claimed.command.attemptId,
              }),
            )
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
    const races = [work, heartbeatFailure]
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
