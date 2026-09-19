import type { RetryPolicy } from '../../types/index.ts'
import type { AttemptCommand } from '../commands.ts'
import type { AttemptExecutor } from '../executors.ts'
import type { StoredAttempt } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { parseDurationMs } from '../duration.ts'

type RetryDeps = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
}

export async function retryAttempt(
  deps: RetryDeps,
  params: {
    readonly command: AttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  const { command, failedAttempt: failed, retry } = params
  if (!shouldRetry(failed, retry)) return false

  const { workflowName, runId, nodeName, childKey } = command
  const attempt = await deps.store.createAttempt({
    runId,
    nodeName,
    childKey,
    input: failed.input,
    idempotencyKey: failed.idempotencyKey,
  })
  const options = dispatchOptions(retry, failed.retryAttemptNumber)
  const { id: attemptId, leaseToken, input, idempotencyKey } = attempt
  const base = {
    workflowName,
    runId,
    nodeName,
    childKey,
    attemptId,
    leaseToken: leaseToken!,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  }

  if (command.kind === 'activityAttempt') {
    await deps.attemptExecutor.dispatchActivity(
      { kind: 'activityAttempt', activityName: command.activityName, ...base },
      options,
    )
  } else {
    await deps.attemptExecutor.dispatchTask(
      {
        kind: 'taskAttempt',
        taskName: command.taskName,
        ...(command.timeout === undefined ? {} : { timeout: command.timeout }),
        ...base,
      },
      options,
    )
  }
  return true
}

function shouldRetry(
  attempt: StoredAttempt,
  retry: RetryPolicy | undefined,
): retry is RetryPolicy {
  return (
    retry !== undefined &&
    (attempt.status === 'failed' || attempt.status === 'timedOut') &&
    attempt.retryAttemptNumber < retry.attempts
  )
}

function dispatchOptions(
  retry: RetryPolicy,
  attemptNumber: number,
): { readonly runAt?: Date } | undefined {
  const delayMs = retryDelayMs(retry, attemptNumber)
  return delayMs > 0 ? { runAt: new Date(Date.now() + delayMs) } : undefined
}

function retryDelayMs(retry: RetryPolicy, attemptNumber: number): number {
  const base = parseDurationMs(retry.delay) ?? 0
  if (base === 0) return 0
  return retry.backoff === 'exponential'
    ? base * 2 ** Math.max(0, attemptNumber - 1)
    : base
}
