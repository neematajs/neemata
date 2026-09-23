import type { RetryPolicy, Timestamp } from '../../types/index.ts'
import type { AttemptCommand } from '../commands.ts'
import type { AttemptExecutor } from '../executors.ts'
import type { StoredAttempt } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import {
  retryBackoffOptions,
  retryDispatchOptions,
} from '../coordinator/attempt.ts'

type RetryAttemptInput = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
}

/**
 * The next attempt and its command are separate writes without
 * `atomicCompletion`, so the caller must keep the failed attempt's command
 * un-acknowledged until this resolves: its redelivery is what repairs a
 * dispatch that never landed (see `redispatchRetry`).
 */
export async function retryAttempt(
  runtime: RetryAttemptInput,
  params: {
    readonly command: AttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<boolean> {
  const { command, failedAttempt: failed, retry } = params
  if (!shouldRetry(failed, retry)) return false

  // A worker that lost its claim can get here after the new claimant already
  // created the retry; `after` makes both share that one successor instead of
  // superseding it with a third attempt.
  const attempt = await runtime.store.createAttempt({
    runId: command.runId,
    nodeName: command.nodeName,
    childKey: command.childKey,
    input: failed.input,
    idempotencyKey: failed.idempotencyKey,
    after: failed.id,
  })
  // Dispatch is deduplicated by attempt id, so replaying it for a live attempt
  // is safe. A settled one means the child already moved past this failure:
  // its own command drives what follows, and the failure must not be reported.
  if (attempt.status !== 'started') return true

  await dispatchAttempt(
    runtime,
    command,
    attempt,
    // Counted from the returned attempt, which need not be the direct
    // successor nor created by this call.
    retryDispatchOptions(attempt, retry),
  )
  return true
}

/**
 * Replays the dispatch of a retry whose command may never have been written.
 * Adapters deduplicate dispatch by attempt id, so this is a no-op whenever the
 * command exists. The backoff counts from the attempt's creation, not from
 * this replay.
 */
export async function redispatchRetry(
  runtime: RetryAttemptInput,
  params: {
    readonly command: AttemptCommand
    readonly failedAttempt: StoredAttempt
    readonly attempt: StoredAttempt
    readonly retry?: RetryPolicy
  },
): Promise<void> {
  const { command, failedAttempt: failed, attempt, retry } = params
  await dispatchAttempt(
    runtime,
    command,
    attempt,
    retry === undefined
      ? undefined
      : retryBackoffOptions(
          retry,
          failed.retryAttemptNumber,
          attempt.dispatchedAt,
        ),
  )
}

async function dispatchAttempt(
  runtime: RetryAttemptInput,
  command: AttemptCommand,
  attempt: StoredAttempt,
  options: { readonly runAt?: Timestamp } | undefined,
): Promise<void> {
  const { id: attemptId, leaseToken, input, idempotencyKey } = attempt
  const { workflowName, runId, nodeName, childKey } = command
  const shared = {
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
    await runtime.attemptExecutor.dispatchActivity(
      {
        kind: 'activityAttempt',
        activityName: command.activityName,
        ...shared,
      },
      options,
    )
    return
  }

  const { taskName, timeout, retry } = command
  await runtime.attemptExecutor.dispatchTask(
    {
      kind: 'taskAttempt',
      taskName,
      ...shared,
      ...(timeout === undefined ? {} : { timeout }),
      ...(retry === undefined ? {} : { retry }),
    },
    options,
  )
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
