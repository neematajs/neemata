import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  TaskInput,
  TaskRun,
  WorkflowInput,
  WorkflowRun,
} from '../types/index.ts'
import type { WorkflowRuntimeAtomicStart } from './coordinator.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { WorkflowScheduler } from './scheduler.ts'
import type { RunSnapshot, StoredRun } from './state.ts'
import type {
  DeadWorkflowCommand,
  DeleteRunResult,
  ListRunsFilter,
  ListRunSummariesResult,
  ListRunsResult,
  NodeSnapshot,
  PruneTerminalRunsParams,
  PruneTerminalRunsResult,
  RunDetail,
  RunFamilyEntry,
  WorkflowRetentionPruner,
  WorkflowStore,
} from './store.ts'
import type { WorkflowWakeEvents } from './wake-events.ts'
import type {
  WorkflowRuntimeAtomicCompletion,
  WorkflowRuntimeAtomicContinuation,
} from './worker.ts'
import { startTaskRun, startWorkflowRun } from './coordinator.ts'
import {
  createWorkflowRuntimeRegistry,
  type RegisteredTaskImplementation,
  type RegisteredWorkflowImplementation,
  type WorkflowRuntimeRegistry,
} from './registry.ts'
import { isTerminalRunStatus } from './status.ts'

export type WorkflowRuntimeStartOptions = {
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly startAt?: Date
}

export type WorkflowRuntimeAdapter = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly retentionPruner?: WorkflowRetentionPruner
  readonly scheduler?: WorkflowScheduler
  readonly wakeEvents?: WorkflowWakeEvents
  readonly atomicStart?: WorkflowRuntimeAtomicStart
  readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly dispose?: () => Promise<void> | void
}

export type CreateWorkflowRuntimeClientInput = WorkflowRuntimeAdapter & {
  readonly workflows?: readonly RegisteredWorkflowImplementation[]
  readonly tasks?: readonly RegisteredTaskImplementation[]
}

export type WorkflowRuntimeClient = {
  readonly start: {
    <Workflow extends AnyWorkflowDefinition>(
      workflow: Workflow,
      input: WorkflowInput<Workflow>,
      options?: WorkflowRuntimeStartOptions,
    ): Promise<WorkflowRun<Workflow>>
    <Task extends AnyTaskDefinition>(
      task: Task,
      input: TaskInput<Task>,
      options?: WorkflowRuntimeStartOptions,
    ): Promise<TaskRun<Task>>
  }
  readonly cancel: (runId: string) => Promise<StoredRun | undefined>
  readonly deleteRun: (runId: string) => Promise<DeleteRunResult>
  readonly retry: (
    runId: string,
    options?: WorkflowRuntimeStartOptions,
  ) => Promise<StoredRun>
  readonly get: (runId: string) => Promise<RunSnapshot | undefined>
  readonly list: (filter?: ListRunsFilter) => Promise<ListRunsResult>
  readonly listSummaries: (
    filter?: ListRunsFilter,
  ) => Promise<ListRunSummariesResult>
  readonly getDetail: (runId: string) => Promise<RunDetail | undefined>
  readonly getNode: (
    runId: string,
    nodeName: string,
  ) => Promise<NodeSnapshot | undefined>
  readonly getFamily: (runId: string) => Promise<readonly RunFamilyEntry[]>
  readonly pruneRuns: (
    params: PruneTerminalRunsParams,
  ) => Promise<PruneTerminalRunsResult>
  readonly listDeadCommands: (params?: {
    readonly runId?: string
  }) => Promise<readonly DeadWorkflowCommand[]>
  readonly requeueDeadCommand: (id: string) => Promise<void>
  readonly schedules: {
    readonly list: WorkflowScheduler['list']
    readonly trigger: WorkflowScheduler['trigger']
    readonly setEnabled: WorkflowScheduler['setEnabled']
  }
}

export function createWorkflowRuntimeClient(
  input: CreateWorkflowRuntimeClientInput,
): WorkflowRuntimeClient {
  const registry = createWorkflowRuntimeRegistry({
    workflows: input.workflows,
    tasks: input.tasks,
  })

  const start = (async (
    runnable: AnyWorkflowDefinition | AnyTaskDefinition,
    runnableInput: unknown,
    options?: WorkflowRuntimeStartOptions,
  ) => {
    switch (runnable.kind) {
      case 'workflow':
        return (await startWorkflowRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          atomicStart: input.atomicStart,
          workflow: runnable,
          implementation: getWorkflowImplementation(registry, runnable),
          input: runnableInput,
          tags: options?.tags,
          idempotencyKey: options?.idempotencyKey,
          startAt: options?.startAt,
        })) as WorkflowRun<typeof runnable>
      case 'task':
        return (await startTaskRun({
          store: input.store,
          runCoordinationExecutor: input.runCoordinationExecutor,
          attemptExecutor: input.attemptExecutor,
          atomicStart: input.atomicStart,
          task: runnable,
          implementation: getTaskImplementation(registry, runnable),
          input: runnableInput,
          tags: options?.tags,
          idempotencyKey: options?.idempotencyKey,
          startAt: options?.startAt,
        })) as TaskRun<typeof runnable>
    }
  }) as WorkflowRuntimeClient['start']
  const requireScheduler = () => {
    if (!input.scheduler) {
      throw new Error('Workflow runtime adapter does not support schedules')
    }
    return input.scheduler
  }

  return Object.freeze({
    start,
    deleteRun: (runId) => input.store.deleteRun(runId),
    retry: (runId, options) =>
      retryRun(input.store, registry, start, runId, options),
    cancel: async (runId) => {
      const run = await input.store.requestRunCancellation({ runId })
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: run.id,
        workflowName: run.workflowName,
      })
      return run
    },
    get: (runId) => input.store.loadRunSnapshot(runId),
    list: (filter) => input.store.listRuns(filter),
    listSummaries: (filter) => input.store.listRunSummaries(filter),
    getDetail: (runId) => input.store.loadRunDetail(runId),
    getNode: (runId, nodeName) =>
      input.store.loadNodeSnapshot({ runId, nodeName }),
    getFamily: (runId) => input.store.listRunFamily(runId),
    pruneRuns: (params) => pruneRuns(input.store, params),
    listDeadCommands: (params) => input.store.listDeadCommands(params),
    requeueDeadCommand: (id) => input.store.requeueDeadCommand(id),
    schedules: {
      list: async () => requireScheduler().list(),
      trigger: async (name) => requireScheduler().trigger(name),
      setEnabled: async (name, enabled) =>
        requireScheduler().setEnabled(name, enabled),
    },
  })
}

async function pruneRuns(
  store: WorkflowStore,
  params: PruneTerminalRunsParams,
): Promise<PruneTerminalRunsResult> {
  const batchSize = normalizePruneBatchSize(params.batchSize)
  if (batchSize < 1) return { deleted: 0 }
  let deleted = 0

  while (true) {
    const result = await store.pruneTerminalRuns({ ...params, batchSize })
    deleted += result.deleted
    if (result.deleted < batchSize) return { deleted }
  }
}

async function retryRun(
  store: WorkflowStore,
  registry: WorkflowRuntimeRegistry,
  start: WorkflowRuntimeClient['start'],
  runId: string,
  options?: WorkflowRuntimeStartOptions,
): Promise<StoredRun> {
  const [run] = await store.loadRuns([runId])
  if (!run) throw new Error(`Run [${runId}] not found`)
  if (!isTerminalRunStatus(run.status)) {
    throw new Error(`Run [${runId}] is not terminal`)
  }
  if (run.parentRunId !== undefined) {
    throw new Error(`Run [${runId}] is not a root run`)
  }

  switch (run.kind) {
    case 'workflow': {
      const implementation = registry.getWorkflow(run.workflowName)
      if (!implementation) {
        throw new Error(
          `No registered workflow implementation [${run.workflowName}]`,
        )
      }
      return (await start(implementation.workflow, run.input as never, {
        tags: run.tags,
        ...options,
      })) as StoredRun
    }
    case 'task': {
      const taskName = run.taskName ?? run.name
      const implementation = registry.getTask(taskName)
      if (!implementation) {
        throw new Error(`No registered task implementation [${taskName}]`)
      }
      return (await start(implementation.task, run.input as never, {
        tags: run.tags,
        ...options,
      })) as StoredRun
    }
  }
}

function normalizePruneBatchSize(batchSize: number | undefined): number {
  if (batchSize === undefined) return 100
  if (!Number.isInteger(batchSize) || batchSize < 1) return 0
  return batchSize
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
