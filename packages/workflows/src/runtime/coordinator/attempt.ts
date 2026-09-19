import type { DurationString } from '../../types/index.ts'
import type { RuntimeDeps } from '../executors.ts'
import type { StoredAttempt } from '../state.ts'
import { SELF_CHILD_KEY, TASK_RUN_NODE_NAME } from '../child-key.ts'
import { failNodeAndRun } from './sinks.ts'

type AttemptParams = {
  readonly workflowName: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
  /** Settle the attempt, node and run before rethrowing a dispatch failure. */
  readonly failRunOnDispatchFailure?: boolean
}

export async function dispatchTaskRunAttempt(
  deps: RuntimeDeps,
  params: {
    readonly taskName: string
    readonly taskRunId: string
    readonly taskInput: unknown
    readonly idempotencyKey?: readonly unknown[]
    readonly timeout?: DurationString
    readonly startAt?: Date
    readonly failRunOnDispatchFailure?: boolean
  },
) {
  await deps.store.createNode({
    runId: params.taskRunId,
    name: TASK_RUN_NODE_NAME,
    kind: 'task',
  })
  await deps.store.setNodeInput({
    runId: params.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    input: params.taskInput,
  })
  await deps.store.ensureNodeChildren({
    runId: params.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    children: [{ childKey: SELF_CHILD_KEY, kind: 'task' }],
  })

  await dispatchTaskAttempt(deps, {
    workflowName: params.taskName,
    taskName: params.taskName,
    runId: params.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    childKey: SELF_CHILD_KEY,
    input: params.taskInput,
    idempotencyKey: params.idempotencyKey,
    timeout: params.timeout,
    runAt: params.startAt,
    failRunOnDispatchFailure: params.failRunOnDispatchFailure,
  })
}

export async function dispatchActivityAttempt(
  deps: RuntimeDeps,
  params: AttemptParams & { readonly activityName: string },
) {
  await dispatchPreparedAttempt(deps, params, async (attempt) => {
    await deps.attemptExecutor.dispatchActivity({
      kind: 'activityAttempt',
      workflowName: params.workflowName,
      activityName: params.activityName,
      runId: params.runId,
      nodeName: params.nodeName,
      childKey: params.childKey,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: attempt.input,
      ...(attempt.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: attempt.idempotencyKey }),
    })
  })
}

export async function dispatchTaskAttempt(
  deps: RuntimeDeps,
  params: AttemptParams & {
    readonly taskName: string
    readonly timeout?: DurationString
    readonly runAt?: Date
  },
) {
  await dispatchPreparedAttempt(deps, params, async (attempt) => {
    await deps.attemptExecutor.dispatchTask(
      {
        kind: 'taskAttempt',
        workflowName: params.workflowName,
        taskName: params.taskName,
        runId: params.runId,
        nodeName: params.nodeName,
        childKey: params.childKey,
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        input: attempt.input,
        ...(attempt.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: attempt.idempotencyKey }),
        ...(params.timeout === undefined ? {} : { timeout: params.timeout }),
      },
      params.runAt === undefined ? undefined : { runAt: params.runAt },
    )
  })
}

async function dispatchPreparedAttempt(
  deps: RuntimeDeps,
  params: AttemptParams,
  dispatch: (attempt: StoredAttempt) => Promise<void>,
) {
  const { attempt, created } = await deps.store.ensureChildAttempt({
    runId: params.runId,
    nodeName: params.nodeName,
    childKey: params.childKey,
    input: params.input,
    idempotencyKey: params.idempotencyKey,
  })

  if (!created && attempt.status !== 'started') return

  try {
    await dispatch(attempt)
  } catch (error) {
    if (params.failRunOnDispatchFailure) {
      await deps.store.failCurrentAttempt({
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        error,
      })
      await failNodeAndRun(deps, {
        runId: params.runId,
        nodeName: params.nodeName,
        error,
      })
    }
    throw error
  }
}
