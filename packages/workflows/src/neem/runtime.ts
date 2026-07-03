import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { MaybePromise } from '../types/index.ts'

export type WorkflowsRuntimeFactory = () => MaybePromise<WorkflowRuntimeAdapter>

export type WorkflowsImplementationsFactory<
  Implementation = WorkflowImplementation,
> = () => MaybePromise<readonly Implementation[]>

export type WorkflowTaskImplementationsFactory<
  Implementation = TaskImplementation,
> = () => MaybePromise<readonly Implementation[]>

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
  TWorkflowImplementation extends WorkflowImplementation =
    WorkflowImplementation,
  TTaskImplementation extends TaskImplementation = TaskImplementation,
> = {
  readonly runtime: WorkflowsRuntimeFactory
  readonly workflows: WorkflowsImplementationsFactory<TWorkflowImplementation>
  readonly tasks?: WorkflowTaskImplementationsFactory<TTaskImplementation>
  readonly workers?: WorkflowsWorkersConfig
}

export type ResolvedWorkflowsConfig<
  TWorkflowImplementation extends WorkflowImplementation =
    WorkflowImplementation,
  TTaskImplementation extends TaskImplementation = TaskImplementation,
> = {
  readonly runtime: WorkflowsRuntimeFactory
  readonly workflows: readonly TWorkflowImplementation[]
  readonly tasks: readonly TTaskImplementation[]
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
  const TWorkflowImplementation extends WorkflowImplementation,
  const TTaskImplementation extends TaskImplementation = TaskImplementation,
>(
  config: WorkflowsConfig<TWorkflowImplementation, TTaskImplementation>,
): WorkflowsConfig<TWorkflowImplementation, TTaskImplementation> {
  return Object.freeze(config)
}

export async function resolveWorkflowsConfig<
  const TWorkflowImplementation extends WorkflowImplementation,
  const TTaskImplementation extends TaskImplementation = TaskImplementation,
>(
  config: WorkflowsConfig<TWorkflowImplementation, TTaskImplementation>,
): Promise<
  ResolvedWorkflowsConfig<TWorkflowImplementation, TTaskImplementation>
> {
  return {
    runtime: config.runtime,
    workflows: await config.workflows(),
    tasks: (await config.tasks?.()) ?? [],
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
