import type { DurationString } from '../../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredAttempt } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { failNodeAndRun } from './sinks.ts'

const TASK_RUN_NODE_NAME = '$task'

export async function dispatchTaskRunAttempt(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly taskName: string
  readonly taskRunId: string
  readonly taskInput: unknown
  readonly idempotencyKey?: readonly unknown[]
  readonly timeout?: DurationString
  readonly throwOnDispatchFailure?: boolean
}) {
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

  await dispatchTaskAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    workflowName: input.taskName,
    taskName: input.taskName,
    runId: input.taskRunId,
    nodeName: TASK_RUN_NODE_NAME,
    timeout: input.timeout,
    throwOnDispatchFailure: input.throwOnDispatchFailure,
    prepareAttempt: async () => {
      const result = await input.store.ensureNodeAttempt({
        identity: {
          runId: input.taskRunId,
          nodeName: TASK_RUN_NODE_NAME,
        },
        kind: 'task',
        input: input.taskInput,
        idempotencyKey: input.idempotencyKey,
      })
      return {
        attempt: result.attempt,
        commandInput: result.created ? input.taskInput : result.attempt.input,
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
  readonly throwOnDispatchFailure?: boolean
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  await dispatchPreparedAttempt(input, async (attempt, commandInput) => {
    await input.attemptExecutor.dispatchActivity({
      kind: 'activityAttempt',
      workflowName: input.workflowName,
      activityName: input.activityName,
      runId: input.runId,
      nodeName: input.nodeName,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: commandInput,
      ...(attempt.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: attempt.idempotencyKey }),
    })
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
  readonly timeout?: DurationString
  readonly throwOnDispatchFailure?: boolean
  readonly prepareAttempt: () => Promise<{
    readonly attempt: StoredAttempt
    readonly commandInput: unknown
    readonly created: boolean
  }>
}) {
  await dispatchPreparedAttempt(input, async (attempt, commandInput) => {
    await input.attemptExecutor.dispatchTask({
      kind: 'taskAttempt',
      workflowName: input.workflowName,
      taskName: input.taskName,
      runId: input.runId,
      nodeName: input.nodeName,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: commandInput,
      ...(attempt.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: attempt.idempotencyKey }),
      ...(input.timeout === undefined ? {} : { timeout: input.timeout }),
    })
  })
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
