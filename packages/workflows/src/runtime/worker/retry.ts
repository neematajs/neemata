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
  input: RetryAttemptInput,
  params: {
    readonly command: ActivityAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  return retryAttemptCore(input, params, async (retryAttempt, options) => {
    await input.attemptExecutor.dispatchActivity(
      {
        kind: 'activityAttempt',
        workflowName: params.command.workflowName,
        activityName: params.command.activityName,
        runId: params.command.runId,
        nodeName: params.command.nodeName,
        attemptId: retryAttempt.id,
        leaseToken: retryAttempt.leaseToken!,
        input: retryAttempt.input,
        ...(retryAttempt.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: retryAttempt.idempotencyKey }),
      },
      options,
    )
  })
}

export async function retryTaskAttempt(
  input: RetryAttemptInput,
  params: {
    readonly command: TaskAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  return retryAttemptCore(input, params, async (retryAttempt, options) => {
    await input.attemptExecutor.dispatchTask(
      {
        kind: 'taskAttempt',
        workflowName: params.command.workflowName,
        taskName: params.command.taskName,
        runId: params.command.runId,
        nodeName: params.command.nodeName,
        attemptId: retryAttempt.id,
        leaseToken: retryAttempt.leaseToken!,
        input: retryAttempt.input,
        ...(retryAttempt.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: retryAttempt.idempotencyKey }),
        ...(params.command.timeout === undefined
          ? {}
          : { timeout: params.command.timeout }),
      },
      options,
    )
  })
}

async function retryAttemptCore(
  input: RetryAttemptInput,
  params: {
    readonly command: ActivityAttemptCommand | TaskAttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
  dispatch: (
    retryAttempt: StoredAttempt,
    options: { readonly runAt?: Date } | undefined,
  ) => Promise<void>,
): Promise<boolean> {
  if (!shouldRetryAttempt(params.failedAttempt, params.retry)) return false

  const retryAttempt = await input.store.createAttempt({
    runId: params.command.runId,
    nodeName: params.command.nodeName,
    input: params.failedAttempt.input,
    idempotencyKey: params.failedAttempt.idempotencyKey,
  })
  await dispatch(
    retryAttempt,
    retryDispatchOptions(params.retry, params.failedAttempt.attemptNumber),
  )
  return true
}

function shouldRetryAttempt(
  failedAttempt: StoredAttempt,
  retry: RetryPolicy | undefined,
): retry is RetryPolicy {
  return retry !== undefined && failedAttempt.attemptNumber < retry.attempts
}

function retryDispatchOptions(
  retry: RetryPolicy | undefined,
  failedAttemptNumber: number,
): { readonly runAt?: Date } | undefined {
  const delayMs = retryDelayMs(retry, failedAttemptNumber)
  return delayMs > 0 ? { runAt: new Date(Date.now() + delayMs) } : undefined
}

function retryDelayMs(
  retry: RetryPolicy | undefined,
  failedAttemptNumber: number,
): number {
  const base = parseDurationMs(retry?.delay) ?? 0
  if (base === 0) return 0
  return retry?.backoff === 'exponential'
    ? base * 2 ** Math.max(0, failedAttemptNumber - 1)
    : base
}
