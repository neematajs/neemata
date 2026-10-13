import type { DurationString, RetryPolicy } from '../types/index.ts'
import type { StoredRun } from './state.ts'

/**
 * Every command carries a copy of its run's `executionRevision` (for an
 * activity, its workflow run's), because routing happens before a worker can
 * read the run: a claim matches `(name, revision)` exactly, so a worker never
 * takes work it has no code for. The run stays the authority once claimed.
 */
export type ContinueRunCommand = {
  readonly kind: 'continueRun'
  readonly runId: string
  readonly workflowName: string
  readonly revision?: string
}

export function continueRunCommand(
  run: Pick<StoredRun, 'id' | 'workflowName' | 'executionRevision'>,
): ContinueRunCommand {
  const { id: runId, workflowName, executionRevision: revision } = run
  return {
    kind: 'continueRun',
    runId,
    workflowName,
    ...(revision === undefined ? {} : { revision }),
  }
}

export type ActivityAttemptCommand = {
  readonly kind: 'activityAttempt'
  readonly workflowName: string
  readonly revision?: string
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
  /** The task run's revision. */
  readonly revision?: string
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

/** One served route. `revision` absent is the unversioned lane, never a wildcard. */
export type RouteRef = {
  readonly name: string
  readonly revision?: string
}

export type RunCoordinationWorkerClaim = {
  readonly workerId: string
  readonly workflows: readonly RouteRef[]
  readonly leaseMs: number
}

export type ExecutionWorkerClaim = {
  readonly workerId: string
  /** Workflows whose activities this worker runs. */
  readonly workflows: readonly RouteRef[]
  readonly activityNames?: readonly string[]
  readonly tasks: readonly RouteRef[]
  readonly leaseMs: number
}

export function servesRoute(
  routes: readonly RouteRef[],
  name: string,
  revision: string | undefined,
): boolean {
  return routes.some(
    (route) => route.name === name && route.revision === revision,
  )
}
