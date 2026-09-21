import type { DurationString, RetryPolicy } from '../types/index.ts'

export type ContinueRunCommand = {
  readonly kind: 'continueRun'
  readonly runId: string
  readonly workflowName: string
}

export type ActivityAttemptCommand = {
  readonly kind: 'activityAttempt'
  readonly workflowName: string
  readonly activityName: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly attemptId: string
  readonly leaseToken: string
  /** Canonical JSON encoding; the worker decodes it before calling the handler. */
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
}

export type TaskAttemptCommand = {
  readonly kind: 'taskAttempt'
  readonly workflowName: string
  readonly taskName: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly attemptId: string
  readonly leaseToken: string
  /** Canonical JSON encoding; retries copy it without decoding/re-encoding. */
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
  readonly timeout?: DurationString
  /** The dispatching node's policy; the task's own policy applies without it. */
  readonly retry?: RetryPolicy
}

export type AttemptCommand = ActivityAttemptCommand | TaskAttemptCommand

export type ClaimedCommand = {
  readonly id: string
  readonly command: ContinueRunCommand
  readonly leaseToken: string
}

export type ClaimedAttempt = {
  readonly id: string
  readonly command: AttemptCommand
  readonly leaseToken: string
}

export type RunCoordinationWorkerClaim = {
  readonly workerId: string
  readonly workflowNames: readonly string[]
  readonly leaseMs: number
}

export type ExecutionWorkerClaim = {
  readonly workerId: string
  readonly workflowNames: readonly string[]
  readonly activityNames?: readonly string[]
  readonly taskNames: readonly string[]
  readonly leaseMs: number
}
