import type { Dependencies } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  IdempotencyKey,
  TaskDecodedInput,
  TaskInput,
  WorkflowDecodedInput,
  WorkflowInput,
} from '../../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredRun } from '../state.ts'
import type { CreateRunInput, WorkflowStore } from '../store.ts'
import { dispatchTaskRunAttempt } from './attempt.ts'
import { decodeSchemaValue, resolveIdempotency, resolveTags } from './codec.ts'

export type StartTaskRunInput<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = Dependencies,
> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly task: Task
  readonly implementation?: TaskImplementation<Task, Deps>
  readonly input: TaskInput<Task>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly startAt?: Date
}

export type StartWorkflowRunInput<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies = Dependencies,
> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly workflow: Workflow
  readonly implementation?: WorkflowImplementation<Workflow, Deps>
  readonly input: WorkflowInput<Workflow>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly startAt?: Date
}

type WorkflowStartMetadataInput<Workflow extends AnyWorkflowDefinition> = {
  readonly workflow: Workflow
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly input: WorkflowDecodedInput<Workflow>
}

export type WorkflowRuntimeAtomicStart = {
  readonly startWorkflowRun: (input: {
    readonly run: CreateRunInput
    readonly startAt?: Date
  }) => Promise<StoredRun>
  readonly startTaskRun: (input: {
    readonly run: CreateRunInput
    readonly taskName: string
    readonly taskInput: unknown
    readonly idempotencyKey?: readonly unknown[]
    readonly startAt?: Date
  }) => Promise<StoredRun>
}

export async function startWorkflowRun<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies = Dependencies,
>(input: StartWorkflowRunInput<Workflow, Deps>): Promise<StoredRun> {
  assertImplementationTarget(
    input.implementation?.workflow,
    input.workflow,
    'Workflow start implementation',
  )
  const workflowInput = decodeSchemaValue(
    input.workflow.input,
    input.input,
    `workflow input [${input.workflow.name}]`,
  ) as WorkflowDecodedInput<Workflow>
  const metadata = resolveWorkflowStartMetadata({
    ...input,
    input: workflowInput,
  })
  const runInput: CreateRunInput = {
    kind: 'workflow',
    name: input.workflow.name,
    workflowName: input.workflow.name,
    input: workflowInput,
    tags: metadata.tags,
    idempotencyKey: metadata.idempotencyKey,
  }

  if (input.atomicStart) {
    return await input.atomicStart.startWorkflowRun({
      run: runInput,
      startAt: input.startAt,
    })
  }

  const run = await input.store.createRun(runInput)

  try {
    const command = {
      kind: 'continueRun',
      runId: run.id,
      workflowName: input.workflow.name,
    } as const
    if (input.startAt) {
      await input.runCoordinationExecutor.enqueueDelayed(command, input.startAt)
    } else {
      await input.runCoordinationExecutor.enqueue(command)
    }
  } catch (error) {
    await input.store.failRun({
      runId: run.id,
      error,
    })
    throw error
  }

  return run
}

export async function startTaskRun<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = Dependencies,
>(input: StartTaskRunInput<Task, Deps>): Promise<StoredRun> {
  assertImplementationTarget(
    input.implementation?.task,
    input.task,
    'Task start implementation',
  )
  const taskInput = decodeSchemaValue(
    input.task.input,
    input.input,
    `task input [${input.task.name}]`,
  ) as TaskDecodedInput<Task>
  const idempotencyKey =
    input.idempotencyKey ??
    resolveIdempotency(input.task.idempotency, taskInput)

  const runInput: CreateRunInput = {
    kind: 'task',
    name: input.task.name,
    workflowName: input.task.name,
    taskName: input.task.name,
    input: taskInput,
    tags: input.tags ?? resolveTags(input.task.tags, taskInput),
    idempotencyKey,
  }

  if (input.atomicStart) {
    return await input.atomicStart.startTaskRun({
      run: runInput,
      taskName: input.task.name,
      taskInput,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      startAt: input.startAt,
    })
  }

  const run = await input.store.createRun(runInput)

  await dispatchTaskRunAttempt({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    taskName: input.task.name,
    taskRunId: run.id,
    taskInput,
    idempotencyKey,
    timeout: input.task.timeout,
    startAt: input.startAt,
    throwOnDispatchFailure: true,
  })

  return run
}

function resolveWorkflowStartMetadata<Workflow extends AnyWorkflowDefinition>(
  input: WorkflowStartMetadataInput<Workflow>,
): {
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: IdempotencyKey
} {
  return {
    tags: input.tags ?? resolveTags(input.workflow.tags, input.input),
    idempotencyKey:
      input.idempotencyKey ??
      resolveIdempotency(input.workflow.idempotency, input.input),
  }
}

function assertImplementationTarget(
  implementationTarget: { readonly name: string } | undefined,
  target: { readonly name: string },
  label: string,
) {
  if (implementationTarget && implementationTarget.name !== target.name) {
    throw new Error(
      `${label} [${implementationTarget.name}] does not match [${target.name}]`,
    )
  }
}
