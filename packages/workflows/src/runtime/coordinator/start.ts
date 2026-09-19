import type { Dependencies } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunUniqueConstraint,
  TaskDecodedInput,
  TaskInput,
  WorkflowDecodedInput,
  WorkflowInput,
} from '../../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredRun } from '../state.ts'
import type { CreateRunInput, WorkflowStore } from '../store.ts'
import { dispatchTaskRunAttempt } from './attempt.ts'
import {
  decodeSchemaValue,
  normalizeRunUnique,
  resolveIdempotency,
  resolveTags,
  resolveUnique,
} from './codec.ts'

type StartRunCommon<Connection> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart<Connection>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly unique?: RunUniqueConstraint
  readonly startAt?: Date
  readonly connection?: Connection
}

export type StartTaskRunInput<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = Dependencies,
  Connection = never,
> = StartRunCommon<Connection> & {
  readonly attemptExecutor: AttemptExecutor
  readonly task: Task
  readonly implementation?: TaskImplementation<Task, Deps>
  readonly input: TaskInput<Task>
}

export type StartWorkflowRunInput<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies = Dependencies,
  Connection = never,
> = StartRunCommon<Connection> & {
  readonly workflow: Workflow
  readonly implementation?: WorkflowImplementation<Workflow, Deps>
  readonly input: WorkflowInput<Workflow>
}

export type WorkflowRuntimeAtomicStart<Connection = never> = {
  readonly startWorkflowRun: (input: {
    readonly run: CreateRunInput
    readonly startAt?: Date
    readonly connection?: Connection
  }) => Promise<StoredRun>
  readonly startTaskRun: (input: {
    readonly run: CreateRunInput
    readonly taskName: string
    readonly taskInput: unknown
    readonly idempotencyKey?: readonly unknown[]
    readonly startAt?: Date
    readonly connection?: Connection
  }) => Promise<StoredRun>
}

export async function startWorkflowRun<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies = Dependencies,
  Connection = never,
>(
  input: StartWorkflowRunInput<Workflow, Deps, Connection>,
): Promise<StoredRun> {
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
  const tags = input.tags ?? resolveTags(input.workflow.tags, workflowInput)
  const idempotencyKey =
    input.idempotencyKey ??
    resolveIdempotency(input.workflow.idempotency, workflowInput)
  const unique = normalizeRunUnique(
    input.unique ?? resolveUnique(input.workflow.unique, workflowInput),
  )
  const runInput: CreateRunInput = {
    kind: 'workflow',
    name: input.workflow.name,
    workflowName: input.workflow.name,
    input: workflowInput,
    tags,
    idempotencyKey,
    ...(unique === undefined ? {} : { unique }),
  }

  if (input.atomicStart) {
    return await input.atomicStart.startWorkflowRun({
      run: runInput,
      startAt: input.startAt,
      ...(input.connection === undefined
        ? {}
        : { connection: input.connection }),
    })
  }
  assertNoStartConnection(input.connection)

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
  Connection = never,
>(input: StartTaskRunInput<Task, Deps, Connection>): Promise<StoredRun> {
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
  const unique = normalizeRunUnique(
    input.unique ?? resolveUnique(input.task.unique, taskInput),
  )
  const tags = input.tags ?? resolveTags(input.task.tags, taskInput)

  const runInput: CreateRunInput = {
    kind: 'task',
    name: input.task.name,
    workflowName: input.task.name,
    taskName: input.task.name,
    input: taskInput,
    tags,
    idempotencyKey,
    ...(unique === undefined ? {} : { unique }),
  }

  if (input.atomicStart) {
    return await input.atomicStart.startTaskRun({
      run: runInput,
      taskName: input.task.name,
      taskInput,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      startAt: input.startAt,
      ...(input.connection === undefined
        ? {}
        : { connection: input.connection }),
    })
  }
  assertNoStartConnection(input.connection)

  const run = await input.store.createRun(runInput)

  await dispatchTaskRunAttempt(input, {
    taskName: input.task.name,
    taskRunId: run.id,
    taskInput,
    idempotencyKey,
    timeout: input.task.timeout,
    startAt: input.startAt,
    failRunOnDispatchFailure: true,
  })

  return run
}

function assertNoStartConnection(connection: unknown) {
  if (connection !== undefined) {
    throw new Error(
      'Workflow runtime adapter does not support caller-provided connections',
    )
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
