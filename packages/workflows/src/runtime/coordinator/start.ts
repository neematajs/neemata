import type { Container, Dependencies, DependencyContext } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  TaskDecodedInput,
  TaskInput,
  WorkflowDecodedInput,
  WorkflowInput,
} from '../../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredRun } from '../state.ts'
import type { CreateRunInput, WorkflowStore } from '../store.ts'
import { dispatchTaskRunAttempt } from './attempt.ts'
import { decodeSchemaValue, resolveIdempotency } from './codec.ts'

export type StartTaskRunInput<
  Task extends AnyTaskDefinition,
  Deps extends Dependencies = Dependencies,
> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly container?: Pick<Container, 'createContext'>
  readonly task: Task
  readonly implementation?: TaskImplementation<Task, Deps>
  readonly input: TaskInput<Task>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type StartWorkflowRunInput<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies = Dependencies,
> = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly container?: Pick<Container, 'createContext'>
  readonly workflow: Workflow
  readonly implementation?: WorkflowImplementation<Workflow, Deps>
  readonly input: WorkflowInput<Workflow>
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

type WorkflowStartMetadataInput<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies,
> = Omit<StartWorkflowRunInput<Workflow, Deps>, 'input'> & {
  readonly input: WorkflowDecodedInput<Workflow>
}

export type WorkflowRuntimeAtomicStart = {
  readonly startWorkflowRun: (input: {
    readonly run: CreateRunInput
  }) => Promise<StoredRun>
  readonly startTaskRun: (input: {
    readonly run: CreateRunInput
    readonly taskName: string
    readonly taskInput: unknown
    readonly idempotencyKey?: readonly unknown[]
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
  const metadata = await resolveWorkflowStartMetadata({
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
    return await input.atomicStart.startWorkflowRun({ run: runInput })
  }

  const run = await input.store.createRun(runInput)

  try {
    await input.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: input.workflow.name,
    })
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
  const taskCtx = await resolveStartContext({
    container: input.container,
    dependencies: input.implementation?.dependencies,
    needsContext:
      input.idempotencyKey === undefined && !!input.implementation?.idempotency,
    label: 'Task start idempotency',
  })
  const taskInput = decodeSchemaValue(
    input.task.input,
    input.input,
    `task input [${input.task.name}]`,
  ) as TaskDecodedInput<Task>
  const idempotencyKey =
    input.idempotencyKey ??
    resolveIdempotency(input.implementation?.idempotency, taskCtx, taskInput)

  const runInput: CreateRunInput = {
    kind: 'task',
    name: input.task.name,
    workflowName: input.task.name,
    taskName: input.task.name,
    input: taskInput,
    tags: input.tags,
    idempotencyKey,
  }

  if (input.atomicStart) {
    return await input.atomicStart.startTaskRun({
      run: runInput,
      taskName: input.task.name,
      taskInput,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
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
    throwOnDispatchFailure: true,
  })

  return run
}

async function resolveWorkflowStartMetadata<
  Workflow extends AnyWorkflowDefinition,
  Deps extends Dependencies,
>(
  input: WorkflowStartMetadataInput<Workflow, Deps>,
): Promise<{
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}> {
  const needsContext =
    (input.tags === undefined && !!input.implementation?.tags) ||
    (input.idempotencyKey === undefined && !!input.implementation?.idempotency)
  const ctx = await resolveStartContext<Deps>({
    container: input.container,
    dependencies: input.implementation?.dependencies,
    needsContext,
    label: 'Workflow start metadata',
  })

  return {
    tags: input.tags ?? input.implementation?.tags?.(ctx, input.input),
    idempotencyKey:
      input.idempotencyKey ??
      resolveIdempotency(input.implementation?.idempotency, ctx, input.input),
  }
}

async function resolveStartContext<Deps extends Dependencies>(input: {
  readonly container: Pick<Container, 'createContext'> | undefined
  readonly dependencies: Deps | undefined
  readonly needsContext: boolean
  readonly label: string
}): Promise<DependencyContext<Deps>> {
  if (!input.needsContext) return {} as DependencyContext<Deps>
  if (!input.container) {
    throw new Error(`${input.label} requires a container`)
  }

  return (await input.container.createContext(
    input.dependencies ?? {},
  )) as DependencyContext<Deps>
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
