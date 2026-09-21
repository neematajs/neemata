import type {
  DurationString,
  RetryPolicy,
  Timestamp,
} from '../../types/index.ts'
import type {
  AttemptDispatchOptions,
  AttemptExecutor,
  RunCoordinationExecutor,
} from '../executors.ts'
import type { StoredAttempt } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { SELF_CHILD_KEY } from '../child-key.ts'
import { parseDurationMs } from '../duration.ts'
import { failNodeAndRun } from './sinks.ts'

const TASK_RUN_NODE_NAME = '$task'

export type DispatchTaskRunAttemptInput = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly taskName: string
  readonly taskRunId: string
  readonly taskInput: unknown
  readonly idempotencyKey?: readonly unknown[]
  readonly timeout?: DurationString
  readonly retry?: RetryPolicy
  readonly startAt?: Timestamp
  readonly throwOnDispatchFailure?: boolean
}

export async function dispatchTaskRunAttempt(
  input: DispatchTaskRunAttemptInput,
) {
  await input.store.createNode({
    runId: input.taskRunId,
    name: TASK_RUN_NODE_NAME,
    kind: 'task',
  })
  await input.store.setNodeInput({
    runId: input.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    input: input.taskInput,
  })
  await input.store.ensureNodeChildren({
    runId: input.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'task' }],
  })

  await dispatchTaskAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.taskName,
    taskName: input.taskName,
    runId: input.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    childKey: SELF_CHILD_KEY,
    timeout: input.timeout,
    retry: input.retry,
    runAt: input.startAt,
    throwOnDispatchFailure: input.throwOnDispatchFailure,
    prepareAttempt: async () => {
      const result = await input.store.ensureChildAttempt({
        runId: input.taskRunId,
        nodeName: TASK_RUN_NODE_NAME,
        childKey: SELF_CHILD_KEY,
        input: input.taskInput,
        idempotencyKey: input.idempotencyKey,
      })
      return {
        attempt: result.attempt,
        commandInput: result.attempt.input,
        created: result.created,
      }
    },
  })
}

export async function dispatchActivityAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflowName: string
  readonly activityName: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly retry?: RetryPolicy
  readonly throwOnDispatchFailure?: boolean
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  await dispatchPreparedAttempt(input, async (attempt, commandInput) => {
    await input.attemptExecutor.dispatchActivity(
      {
        kind: 'activityAttempt',
        workflowName: input.workflowName,
        activityName: input.activityName,
        runId: input.runId,
        nodeName: input.nodeName,
        childKey: input.childKey,
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        input: commandInput,
        ...(attempt.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: attempt.idempotencyKey }),
      },
      retryDispatchOptions(attempt, input.retry),
    )
  })
}

export async function dispatchTaskAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflowName: string
  readonly taskName: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly timeout?: DurationString
  readonly retry?: RetryPolicy
  readonly runAt?: Timestamp
  readonly throwOnDispatchFailure?: boolean
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  await dispatchPreparedAttempt(input, async (attempt, commandInput) => {
    await input.attemptExecutor.dispatchTask(
      {
        kind: 'taskAttempt',
        workflowName: input.workflowName,
        taskName: input.taskName,
        runId: input.runId,
        nodeName: input.nodeName,
        childKey: input.childKey,
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        input: commandInput,
        ...(attempt.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: attempt.idempotencyKey }),
        ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
        ...(input.retry === undefined ? {} : { retry: input.retry }),
      },
      attempt.retryAttemptNumber > 1
        ? retryDispatchOptions(attempt, input.retry)
        : input.runAt === undefined
          ? undefined
          : { runAt: input.runAt },
    )
  })
}

/**
 * Coordination can reach a retry before the worker that created it has
 * written its delayed command, and dispatch is deduplicated by attempt id: an
 * immediate command here would discard the backoff. Every dispatch path
 * therefore derives the same deadline, counted from the attempt's creation.
 */
export function retryDispatchOptions(
  attempt: Pick<StoredAttempt, 'retryAttemptNumber' | 'dispatchedAt'>,
  retry: RetryPolicy | undefined,
): AttemptDispatchOptions | undefined {
  if (retry === undefined || attempt.retryAttemptNumber <= 1) return undefined
  return retryBackoffOptions(
    retry,
    attempt.retryAttemptNumber - 1,
    attempt.dispatchedAt,
  )
}

export function retryBackoffOptions(
  retry: RetryPolicy,
  failedAttemptNumber: number,
  from: Timestamp,
): AttemptDispatchOptions | undefined {
  const delayMs = retryDelayMs(retry, failedAttemptNumber)
  return delayMs > 0 ? { runAt: from + delayMs } : undefined
}

function retryDelayMs(retry: RetryPolicy, failedAttemptNumber: number): number {
  const base = parseDurationMs(retry.delay) ?? 0
  if (base === 0) return 0
  return retry.backoff === 'exponential'
    ? base * 2 ** Math.max(0, failedAttemptNumber - 1)
    : base
}

async function dispatchPreparedAttempt(
  input: {
    readonly store: WorkflowStore
    readonly runCoordinationExecutor: RunCoordinationExecutor
    readonly runId: string
    readonly nodeName: string
    readonly throwOnDispatchFailure?: boolean
    readonly prepareAttempt: () => Promise<{
      readonly attempt: StoredAttempt
      readonly commandInput: unknown
      readonly created: boolean
    }>
  },
  dispatch: (attempt: StoredAttempt, commandInput: unknown) => Promise<void>,
) {
  const { attempt, commandInput, created } = await input.prepareAttempt()

  if (!created && attempt.status !== 'started') return

  try {
    await dispatch(attempt, commandInput)
  } catch (error) {
    if (input.throwOnDispatchFailure) {
      await input.store.failCurrentAttempt({
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        error,
      })
      await failNodeAndRun({
        store: input.store,
        runCoordinationExecutor: input.runCoordinationExecutor,
        runId: input.runId,
        nodeName: input.nodeName,
        error,
      })
    }
    throw error
  }
}
