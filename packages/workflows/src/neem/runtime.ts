import type { ExecutionEnvironmentPlugin } from '@nmtjs/core'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { AnyScheduleDefinition, MaybePromise } from '../types/index.ts'
import {
  collectChildWorkflowNames,
  collectWorkflowActivityNames,
  collectWorkflowTaskNames,
} from '../runtime/worker.ts'

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

export type WorkflowWorkerRole = 'coordinator' | 'execution'

export type WorkflowsWorkerPoolConfig = {
  readonly threads?: number
  readonly concurrency?: number
  readonly leaseMs?: number
  readonly pollIntervalMs?: number
}

export type WorkflowsExecutionWorkerPoolConfig = WorkflowsWorkerPoolConfig & {
  readonly activityNames?: readonly string[]
  readonly taskNames?: readonly string[]
}

export type WorkflowsNamedExecutionWorkerPoolConfig =
  WorkflowsExecutionWorkerPoolConfig & {
    readonly name: string
  }

export type WorkflowsWorkersConfig = {
  readonly coordinator?: WorkflowsWorkerPoolConfig
  /**
   * One shared execution pool by default, or named pools selected by activity
   * and task names. At most one named pool may omit both selectors to claim
   * everything not assigned explicitly elsewhere.
   */
  readonly execution?:
    | WorkflowsExecutionWorkerPoolConfig
    | readonly WorkflowsNamedExecutionWorkerPoolConfig[]
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
  readonly plugins?: readonly ExecutionEnvironmentPlugin[]
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
  readonly plugins: readonly ExecutionEnvironmentPlugin[]
  readonly workers: {
    readonly coordinator: Required<WorkflowsWorkerPoolConfig>
    readonly execution: readonly ResolvedExecutionWorkerPool[]
  }
}

export type ResolvedExecutionWorkerPool =
  Required<WorkflowsWorkerPoolConfig> & {
    readonly name: string
    readonly activityNames: readonly string[]
    readonly taskNames: readonly string[]
  }

export type WorkflowsWorkerData = {
  readonly role: WorkflowWorkerRole
  /** Which resolved execution pool this worker serves; execution role only. */
  readonly pool?: string
}

export const DEFAULT_EXECUTION_POOL_NAME = 'execution'

const defaultWorkerConfig = {
  threads: 1,
  concurrency: 1,
  leaseMs: 30_000,
  pollIntervalMs: 250,
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
  const workflows = await config.workflows()
  const tasks = (await config.tasks?.()) ?? []
  const workerConfig = config.workers as
    | (WorkflowsWorkersConfig & Record<string, unknown>)
    | undefined
  if (workerConfig && ('activity' in workerConfig || 'task' in workerConfig)) {
    throw new Error(
      'Workflows workers.activity and workers.task were replaced by workers.execution',
    )
  }
  return {
    runtime: config.runtime,
    workflows,
    tasks,
    schedules: (await config.schedules?.()) ?? [],
    plugins: config.plugins ?? [],
    workers: {
      coordinator: normalizeWorkerPool(config.workers?.coordinator),
      execution: normalizeExecutionWorkerPools(
        config.workers?.execution,
        workflows,
        tasks,
      ),
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

function normalizeExecutionWorkerPools(
  config:
    | WorkflowsExecutionWorkerPoolConfig
    | readonly WorkflowsNamedExecutionWorkerPoolConfig[]
    | undefined,
  workflows: readonly AnyWorkflowImplementation[],
  tasks: readonly AnyTaskImplementation[],
): readonly ResolvedExecutionWorkerPool[] {
  const pools: readonly WorkflowsNamedExecutionWorkerPoolConfig[] =
    config === undefined || !Array.isArray(config)
      ? [
          {
            name: DEFAULT_EXECUTION_POOL_NAME,
            ...(config as WorkflowsExecutionWorkerPoolConfig | undefined),
          },
        ]
      : (config as readonly WorkflowsNamedExecutionWorkerPoolConfig[])
  if (pools.length === 0) {
    throw new Error('Workflows execution worker pool list must not be empty')
  }

  const names = new Set<string>()
  const claimedActivities = new Map<string, string>()
  const claimedTasks = new Map<string, string>()
  let catchAll: string | undefined
  for (const pool of pools) {
    if (!pool.name) {
      throw new Error('Workflows execution worker pool requires a name')
    }
    if (names.has(pool.name)) {
      throw new Error(
        `Duplicate workflows execution worker pool name [${pool.name}]`,
      )
    }
    names.add(pool.name)

    if (pool.activityNames === undefined && pool.taskNames === undefined) {
      // A single catch-all keeps routing deterministic across both namespaces.
      if (catchAll !== undefined) {
        throw new Error(
          `Workflows execution worker pools [${catchAll}] and [${pool.name}] both omit activityNames and taskNames; only one catch-all pool is allowed`,
        )
      }
      catchAll = pool.name
      continue
    }

    for (const activityName of pool.activityNames ?? []) {
      const owner = claimedActivities.get(activityName)
      if (owner !== undefined) {
        throw new Error(
          `Activity [${activityName}] is claimed by both workflows execution pools [${owner}] and [${pool.name}]`,
        )
      }
      claimedActivities.set(activityName, pool.name)
    }
    for (const taskName of pool.taskNames ?? []) {
      const owner = claimedTasks.get(taskName)
      if (owner !== undefined) {
        throw new Error(
          `Task [${taskName}] is claimed by both workflows execution pools [${owner}] and [${pool.name}]`,
        )
      }
      claimedTasks.set(taskName, pool.name)
    }
  }

  const registeredActivities = new Set(collectWorkflowActivityNames(workflows))
  const registeredWorkflows = new Set(
    workflows.map((implementation) => implementation.workflow.name),
  )
  const missingChildWorkflows = collectChildWorkflowNames(workflows).filter(
    (name) => !registeredWorkflows.has(name),
  )
  if (missingChildWorkflows.length > 0) {
    throw new Error(
      `Workflows [${missingChildWorkflows.join(', ')}] referenced by registered workflows have no registered implementation`,
    )
  }
  const registeredTasks = new Set(
    tasks.map((implementation) => implementation.task.name),
  )
  const missingTaskImplementations = collectWorkflowTaskNames(workflows).filter(
    (name) => !registeredTasks.has(name),
  )
  if (missingTaskImplementations.length > 0) {
    throw new Error(
      `Tasks [${missingTaskImplementations.join(', ')}] referenced by registered workflows have no registered implementation`,
    )
  }
  const unknownActivities = [...claimedActivities.keys()].filter(
    (name) => !registeredActivities.has(name),
  )
  if (unknownActivities.length > 0) {
    throw new Error(
      `Activities [${unknownActivities.join(', ')}] selected by workflows execution pools do not exist in the registered workflows`,
    )
  }
  const unknownTasks = [...claimedTasks.keys()].filter(
    (name) => !registeredTasks.has(name),
  )
  if (unknownTasks.length > 0) {
    throw new Error(
      `Tasks [${unknownTasks.join(', ')}] selected by workflows execution pools do not exist in the registered tasks`,
    )
  }

  // Missing coverage would otherwise leave durable commands stalled forever.
  if (catchAll === undefined) {
    const uncoveredActivities = [...registeredActivities].filter(
      (name) => !claimedActivities.has(name),
    )
    if (uncoveredActivities.length > 0) {
      throw new Error(
        `Activities [${uncoveredActivities.join(', ')}] are not claimed by any workflows execution pool`,
      )
    }
    const uncoveredTasks = [...registeredTasks].filter(
      (name) => !claimedTasks.has(name),
    )
    if (uncoveredTasks.length > 0) {
      throw new Error(
        `Tasks [${uncoveredTasks.join(', ')}] are not claimed by any workflows execution pool`,
      )
    }
  }

  return pools.map((pool) => {
    const isCatchAll = pool.name === catchAll
    return Object.freeze({
      ...normalizeWorkerPool(pool),
      name: pool.name,
      activityNames:
        pool.activityNames ??
        (isCatchAll
          ? [...registeredActivities].filter(
              (name) => !claimedActivities.has(name),
            )
          : []),
      taskNames:
        pool.taskNames ??
        (isCatchAll
          ? [...registeredTasks].filter((name) => !claimedTasks.has(name))
          : []),
    })
  })
}
