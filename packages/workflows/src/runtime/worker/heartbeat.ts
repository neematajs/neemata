import type { ClaimedAttempt } from '../commands.ts'
import type { AttemptExecutor } from '../executors.ts'
import { DEFAULT_LEASE_MS, isAttemptHeartbeatLeaseLost } from './loop.ts'

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

export async function runWithAttemptHeartbeat<T>(
  input: {
    readonly attemptExecutor: AttemptExecutor
    readonly claimed: ClaimedAttempt
    readonly leaseMs?: number
  },
  handler: () => Promise<T>,
  timeout?: {
    readonly timeoutMs: number
    readonly createError: () => Error
  },
): Promise<T> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  const intervalMs = Math.max(1, Math.floor(leaseMs / 3))
  let heartbeatRunning = false
  let heartbeatFailed = false
  let rejectHeartbeat: (error: unknown) => void = () => {}
  const heartbeatFailure = new Promise<never>((_resolve, reject) => {
    rejectHeartbeat = reject
  })
  const interval = setInterval(() => {
    if (heartbeatRunning || heartbeatFailed) return
    heartbeatRunning = true
    void input.attemptExecutor
      .heartbeat(input.claimed, leaseMs)
      .catch((error: unknown) => {
        if (!isAttemptHeartbeatLeaseLost(error)) return
        heartbeatFailed = true
        rejectHeartbeat(error)
      })
      .finally(() => {
        heartbeatRunning = false
      })
  }, intervalMs)
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutFailure =
    timeout === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(
            () => reject(timeout.createError()),
            timeout.timeoutMs,
          )
        })

  try {
    const work = handler()
    work.catch(() => {})
    return await Promise.race(
      timeoutFailure === undefined
        ? [work, heartbeatFailure]
        : [work, heartbeatFailure, timeoutFailure],
    )
  } finally {
    clearInterval(interval)
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}
