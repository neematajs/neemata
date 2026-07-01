import type { Container } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  TaskInput,
  WorkflowInput,
} from '../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { RunSnapshot, StoredRun } from './state.ts'
import type { ListRunsFilter, ListRunsResult, WorkflowStore } from './store.ts'
import { startTaskRun, startWorkflowRun } from './coordinator.ts'
import type { WorkflowRuntimeAtomicStart } from './coordinator.ts'
import type {
  WorkflowRuntimeAtomicCompletion,
  WorkflowRuntimeAtomicContinuation,
} from './worker.ts'
import {
  createWorkflowRuntimeRegistry,
  type RegisteredTaskImplementation,
  type RegisteredWorkflowImplementation,
  type WorkflowRuntimeRegistry,
} from './registry.ts'

export type WorkflowRuntimeStartOptions = {
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type WorkflowRuntimeAdapter = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
}

export type CreateWorkflowRuntimeClientInput = WorkflowRuntimeAdapter & {
  readonly container?: Pick<Container, 'createContext'>
  readonly workflows?: readonly RegisteredWorkflowImplementation[]
  readonly tasks?: readonly RegisteredTaskImplementation[]
}

export type WorkflowRuntimeClient = {
  readonly start: {
    <Workflow extends AnyWorkflowDefinition>(
      workflow: Workflow,
      input: WorkflowInput<Workflow>,
      options?: WorkflowRuntimeStartOptions,
    ): Promise<StoredRun>
    <Task extends AnyTaskDefinition>(
      task: Task,
      input: TaskInput<Task>,
      options?: WorkflowRuntimeStartOptions,
    ): Promise<StoredRun>
  }
  readonly get: (runId: string) => Promise<RunSnapshot | undefined>
  readonly list: (filter?: ListRunsFilter) => Promise<ListRunsResult>
}

export function createWorkflowRuntimeClient(
  input: CreateWorkflowRuntimeClientInput,
): WorkflowRuntimeClient {
  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows,
    tasks: input.tasks,
  })

  const start: WorkflowRuntimeClient['start'] = async (
    runnable: AnyWorkflowDefinition | AnyTaskDefinition,
    runnableInput: unknown,
    options?: WorkflowRuntimeStartOptions,
  ) => {
    switch (runnable.kind) {
      case 'workflow':
        return startWorkflowRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          atomicStart: input.atomicStart,
          container: input.container,
          workflow: runnable,
          implementation: getWorkflowImplementation(registry, runnable),
          input: runnableInput,
          tags: options?.tags,
          idempotencyKey: options?.idempotencyKey,
        })
      case 'task':
        return startTaskRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          attemptExecutor: input.attemptExecutor,
          atomicStart: input.atomicStart,
          container: input.container,
          task: runnable,
          implementation: getTaskImplementation(registry, runnable),
          input: runnableInput,
          tags: options?.tags,
          idempotencyKey: options?.idempotencyKey,
        })
    }
  }

  return Object.freeze({
    start,
    get: (runId) => input.store.loadRunSnapshot(runId),
    list: (filter) => input.store.listRuns(filter),
  })
}

function getWorkflowImplementation<WorkflowDef extends AnyWorkflowDefinition>(
  registry: WorkflowRuntimeRegistry,
  workflow: WorkflowDef,
) {
  const implementation = registry.getWorkflow(workflow.name)
  if (!implementation) return undefined
  if (implementation.workflow !== workflow) {
    throw new Error(
      `Registered workflow implementation [${workflow.name}] does not match declaration`,
    )
  }

  return implementation as WorkflowImplementation<WorkflowDef, any>
}

function getTaskImplementation<TaskDef extends AnyTaskDefinition>(
  registry: WorkflowRuntimeRegistry,
  task: TaskDef,
) {
  const implementation = registry.getTask(task.name)
  if (!implementation) return undefined
  if (implementation.task !== task) {
    throw new Error(
      `Registered task implementation [${task.name}] does not match declaration`,
    )
  }

  return implementation as TaskImplementation<TaskDef, any>
}
