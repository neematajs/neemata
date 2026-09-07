import type { RetryPolicy } from '../../types/index.ts'
import type { ActivityAttemptCommand, TaskAttemptCommand } from '../commands.ts'
import type { AttemptExecutor } from '../executors.ts'
import type { StoredAttempt } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { parseDurationMs } from '../duration.ts'

type RetryAttemptInput = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
}

export async function retryActivityAttempt(
  runtime: RetryAttemptInput,
  params: {
    readonly command: ActivityAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  const { command } = params
  return retryAttempt(runtime, params, async (attempt, options) => {
    const { workflowName, activityName, runId, nodeName, childKey } = command
    const { id: attemptId, leaseToken, input, idempotencyKey } = attempt
    await runtime.attemptExecutor.dispatchActivity(
      {
        kind: 'activityAttempt',
        workflowName,
        activityName,
        runId,
        nodeName,
        childKey,
        attemptId,
        leaseToken: leaseToken!,
        input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
      options,
    )
  })
}

export async function retryTaskAttempt(
  runtime: RetryAttemptInput,
  params: {
    readonly command: TaskAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  const { command } = params
  return retryAttempt(runtime, params, async (attempt, options) => {
    const { workflowName, taskName, runId, nodeName, childKey, timeout } =
      command
    const { id: attemptId, leaseToken, input, idempotencyKey } = attempt
    await runtime.attemptExecutor.dispatchTask(
      {
        kind: 'taskAttempt',
        workflowName,
        taskName,
        runId,
        nodeName,
        childKey,
        attemptId,
        leaseToken: leaseToken!,
        input,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        ...(timeout === undefined ? {} : { timeout }),
      },
      options,
    )
  })
}

async function retryAttempt(
  runtime: RetryAttemptInput,
  params: {
    readonly command: ActivityAttemptCommand | TaskAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
  dispatch: (
    attempt: StoredAttempt,
    options: { readonly runAt?: Date } | undefined,
  ) => Promise<void>,
): Promise<boolean> {
  const { command, failedAttempt: failed, retry } = params
  if (!shouldRetry(failed, retry)) return false

  const attempt = await runtime.store.createAttempt({
    runId: command.runId,
    nodeName: command.nodeName,
    childKey: command.childKey,
    input: failed.input,
    idempotencyKey: failed.idempotencyKey,
  })
  const options = dispatchOptions(retry, failed.retryAttemptNumber)
  await dispatch(attempt, options)
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
