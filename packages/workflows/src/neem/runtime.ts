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
  const { workers } = config
  if (workers && ('activity' in workers || 'task' in workers)) {
    throw new Error(
      'Workflows workers.activity and workers.task were replaced by workers.execution',
    )
  }
  const schedules = (await config.schedules?.()) ?? []
  const plugins = config.plugins ?? []
  const coordinator = normalizePool(workers?.coordinator)
  const execution = normalizeExecutionPools(
    workers?.execution,
    workflows,
    tasks,
  )

  return {
    runtime: config.runtime,
    workflows,
    tasks,
    schedules,
    plugins,
    workers: { coordinator, execution },
  }
}

function normalizePool<T extends WorkflowsWorkerPoolConfig>(
  config: T | undefined,
) {
  return Object.freeze({
    ...defaultWorkerConfig,
    ...config,
  })
}

function normalizeExecutionPools(
  config:
    | WorkflowsExecutionWorkerPoolConfig
    | readonly WorkflowsNamedExecutionWorkerPoolConfig[]
    | undefined,
  workflows: readonly AnyWorkflowImplementation[],
  tasks: readonly AnyTaskImplementation[],
): readonly ResolvedExecutionWorkerPool[] {
  let pools: readonly WorkflowsNamedExecutionWorkerPoolConfig[]
  if (Array.isArray(config)) {
    pools = config
  } else {
    pools = [
      {
        name: DEFAULT_EXECUTION_POOL_NAME,
        ...(config as WorkflowsExecutionWorkerPoolConfig | undefined),
      },
    ]
  }
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
  const missingWorkflows = collectChildWorkflowNames(workflows).filter(
    (name) => !registeredWorkflows.has(name),
  )
  if (missingWorkflows.length > 0) {
    throw new Error(
      `Workflows [${missingWorkflows.join(', ')}] referenced by registered workflows have no registered implementation`,
    )
  }
  const registeredTasks = new Set(
    tasks.map((implementation) => implementation.task.name),
  )
  const missingTasks = collectWorkflowTaskNames(workflows).filter(
    (name) => !registeredTasks.has(name),
  )
  if (missingTasks.length > 0) {
    throw new Error(
      `Tasks [${missingTasks.join(', ')}] referenced by registered workflows have no registered implementation`,
    )
  }
  const unknownActivities = Array.from(claimedActivities.keys()).filter(
    (name) => !registeredActivities.has(name),
  )
  if (unknownActivities.length > 0) {
    throw new Error(
      `Activities [${unknownActivities.join(', ')}] selected by workflows execution pools do not exist in the registered workflows`,
    )
  }
  const unknownTasks = Array.from(claimedTasks.keys()).filter(
    (name) => !registeredTasks.has(name),
  )
  if (unknownTasks.length > 0) {
    throw new Error(
      `Tasks [${unknownTasks.join(', ')}] selected by workflows execution pools do not exist in the registered tasks`,
    )
  }

  const unclaimedActivities = Array.from(registeredActivities).filter(
    (name) => !claimedActivities.has(name),
  )
  const unclaimedTasks = Array.from(registeredTasks).filter(
    (name) => !claimedTasks.has(name),
  )

  // Missing coverage would otherwise leave durable commands stalled forever.
  if (catchAll === undefined) {
    if (unclaimedActivities.length > 0) {
      throw new Error(
        `Activities [${unclaimedActivities.join(', ')}] are not claimed by any workflows execution pool`,
      )
    }
    if (unclaimedTasks.length > 0) {
      throw new Error(
        `Tasks [${unclaimedTasks.join(', ')}] are not claimed by any workflows execution pool`,
      )
    }
  }

  return pools.map((pool) => {
    const isCatchAll = pool.name === catchAll
    const activityNames =
      pool.activityNames ?? (isCatchAll ? unclaimedActivities : [])
    const taskNames = pool.taskNames ?? (isCatchAll ? unclaimedTasks : [])

    return Object.freeze({
      ...normalizePool(pool),
      name: pool.name,
      activityNames,
      taskNames,
    })
  })
}
