import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { AnyScheduleDefinition, MaybePromise } from '../types/index.ts'

export type AnyWorkflowImplementation = Omit<
  WorkflowImplementation,
  'finish'
> & {
  readonly finish: (...args: any[]) => unknown
}
export type AnyTaskImplementation = Omit<TaskImplementation, 'handler'> & {
  readonly handler: (...args: any[]) => unknown
}

export type WorkflowsRuntimeFactory = () => MaybePromise<WorkflowRuntimeAdapter>

export type WorkflowsImplementationsFactory<
  Implementation = AnyWorkflowImplementation,
> = () => MaybePromise<readonly Implementation[]>

export type WorkflowTaskImplementationsFactory<
  Implementation = AnyTaskImplementation,
> = () => MaybePromise<readonly Implementation[]>

export type WorkflowSchedulesFactory<
  Schedule extends AnyScheduleDefinition = AnyScheduleDefinition,
> = () => MaybePromise<readonly Schedule[]>

export type WorkflowWorkerRole = 'coordinator' | 'activity' | 'task'

export type WorkflowsWorkerPoolConfig = {
  readonly threads?: number
  readonly concurrency?: number
  readonly leaseMs?: number
  readonly pollIntervalMs?: number
  readonly maxIdleClaims?: number
}

export type WorkflowsActivityWorkerPoolConfig = WorkflowsWorkerPoolConfig & {
  readonly activityNames?: readonly string[]
}

export type WorkflowsWorkersConfig = {
  readonly coordinator?: WorkflowsWorkerPoolConfig
  readonly activity?: WorkflowsActivityWorkerPoolConfig
  readonly task?: WorkflowsWorkerPoolConfig
}

export type WorkflowsConfig<
  TWorkflowImplementation extends AnyWorkflowImplementation =
    AnyWorkflowImplementation,
  TTaskImplementation extends AnyTaskImplementation = AnyTaskImplementation,
  TScheduleDefinition extends AnyScheduleDefinition = AnyScheduleDefinition,
> = {
  readonly runtime: WorkflowsRuntimeFactory
  readonly workflows: WorkflowsImplementationsFactory<TWorkflowImplementation>
  readonly tasks?: WorkflowTaskImplementationsFactory<TTaskImplementation>
  readonly schedules?: WorkflowSchedulesFactory<TScheduleDefinition>
  readonly workers?: WorkflowsWorkersConfig
}

export type ResolvedWorkflowsConfig<
  TWorkflowImplementation extends AnyWorkflowImplementation =
    AnyWorkflowImplementation,
  TTaskImplementation extends AnyTaskImplementation = AnyTaskImplementation,
  TScheduleDefinition extends AnyScheduleDefinition = AnyScheduleDefinition,
> = {
  readonly runtime: WorkflowsRuntimeFactory
  readonly workflows: readonly TWorkflowImplementation[]
  readonly tasks: readonly TTaskImplementation[]
  readonly schedules: readonly TScheduleDefinition[]
  readonly workers: Required<{
    readonly coordinator: Required<WorkflowsWorkerPoolConfig>
    readonly activity: Required<WorkflowsActivityWorkerPoolConfig>
    readonly task: Required<WorkflowsWorkerPoolConfig>
  }>
}

export type WorkflowsWorkerData = {
  readonly role: WorkflowWorkerRole
}

const defaultWorkerConfig = {
  threads: 1,
  concurrency: 1,
  leaseMs: 30_000,
  pollIntervalMs: 250,
  maxIdleClaims: 1,
} as const

export function defineWorkflows<
  const TWorkflowImplementation extends AnyWorkflowImplementation,
  const TTaskImplementation extends AnyTaskImplementation =
    AnyTaskImplementation,
  const TScheduleDefinition extends AnyScheduleDefinition =
    AnyScheduleDefinition,
>(
  config: WorkflowsConfig<
    TWorkflowImplementation,
    TTaskImplementation,
    TScheduleDefinition
  >,
): WorkflowsConfig<
  TWorkflowImplementation,
  TTaskImplementation,
  TScheduleDefinition
> {
  return Object.freeze(config)
}

export async function resolveWorkflowsConfig<
  const TWorkflowImplementation extends AnyWorkflowImplementation,
  const TTaskImplementation extends AnyTaskImplementation =
    AnyTaskImplementation,
  const TScheduleDefinition extends AnyScheduleDefinition =
    AnyScheduleDefinition,
>(
  config: WorkflowsConfig<
    TWorkflowImplementation,
    TTaskImplementation,
    TScheduleDefinition
  >,
): Promise<
  ResolvedWorkflowsConfig<
    TWorkflowImplementation,
    TTaskImplementation,
    TScheduleDefinition
  >
> {
  return {
    runtime: config.runtime,
    workflows: await config.workflows(),
    tasks: (await config.tasks?.()) ?? [],
    schedules: (await config.schedules?.()) ?? [],
    workers: {
      coordinator: normalizeWorkerPool(config.workers?.coordinator),
      activity: normalizeWorkerPool(config.workers?.activity),
      task: normalizeWorkerPool(config.workers?.task),
    },
  }
}

function normalizeWorkerPool<TConfig extends WorkflowsWorkerPoolConfig>(
  config: TConfig | undefined,
): Required<TConfig & WorkflowsWorkerPoolConfig> {
  return Object.freeze({
    ...defaultWorkerConfig,
    ...config,
  }) as Required<TConfig & WorkflowsWorkerPoolConfig>
}
