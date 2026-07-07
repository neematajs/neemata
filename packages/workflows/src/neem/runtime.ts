import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { AnyScheduleDefinition, MaybePromise } from '../types/index.ts'
import { collectWorkflowActivityNames } from '../runtime/worker.ts'

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

export type WorkflowsNamedActivityWorkerPoolConfig =
  WorkflowsActivityWorkerPoolConfig & {
    readonly name: string
  }

export type WorkflowsWorkersConfig = {
  readonly coordinator?: WorkflowsWorkerPoolConfig
  /**
   * Either one shared pool (default) or multiple isolated named pools. With
   * named pools, each claims only its `activityNames`; at most one pool may
   * omit `activityNames` to act as the catch-all for unmatched activities.
   */
  readonly activity?:
    | WorkflowsActivityWorkerPoolConfig
    | readonly WorkflowsNamedActivityWorkerPoolConfig[]
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
  readonly workers: {
    readonly coordinator: Required<WorkflowsWorkerPoolConfig>
    readonly activity: readonly ResolvedActivityWorkerPool[]
    readonly task: Required<WorkflowsWorkerPoolConfig>
  }
}

export type ResolvedActivityWorkerPool = Required<WorkflowsWorkerPoolConfig> & {
  readonly name: string
  readonly activityNames?: readonly string[]
}

export type WorkflowsWorkerData = {
  readonly role: WorkflowWorkerRole
  /** Which resolved activity pool this worker serves; activity role only. */
  readonly activityPool?: string
}

export const DEFAULT_ACTIVITY_POOL_NAME = 'activity'

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
  const workflows = await config.workflows()
  return {
    runtime: config.runtime,
    workflows,
    tasks: (await config.tasks?.()) ?? [],
    schedules: (await config.schedules?.()) ?? [],
    workers: {
      coordinator: normalizeWorkerPool(config.workers?.coordinator),
      activity: normalizeActivityWorkerPools(
        config.workers?.activity,
        workflows,
      ),
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

function normalizeActivityWorkerPools(
  config:
    | WorkflowsActivityWorkerPoolConfig
    | readonly WorkflowsNamedActivityWorkerPoolConfig[]
    | undefined,
  workflows: readonly AnyWorkflowImplementation[],
): readonly ResolvedActivityWorkerPool[] {
  if (config === undefined || !Array.isArray(config)) {
    return [
      {
        name: DEFAULT_ACTIVITY_POOL_NAME,
        ...normalizeWorkerPool(
          config as WorkflowsActivityWorkerPoolConfig | undefined,
        ),
      },
    ]
  }

  const pools = config as readonly WorkflowsNamedActivityWorkerPoolConfig[]
  if (pools.length === 0) {
    throw new Error('Workflows activity worker pool list must not be empty')
  }

  const names = new Set<string>()
  const claimedActivities = new Map<string, string>()
  let catchAll: string | undefined
  for (const pool of pools) {
    if (!pool.name) {
      throw new Error('Workflows activity worker pool requires a name')
    }
    if (names.has(pool.name)) {
      throw new Error(
        `Duplicate workflows activity worker pool name [${pool.name}]`,
      )
    }
    names.add(pool.name)

    if (pool.activityNames === undefined) {
      // two catch-alls would race for the same unmatched activities with
      // conflicting cadence/lease settings
      if (catchAll !== undefined) {
        throw new Error(
          `Workflows activity worker pools [${catchAll}] and [${pool.name}] both omit activityNames; only one catch-all pool is allowed`,
        )
      }
      catchAll = pool.name
      continue
    }

    for (const activityName of pool.activityNames) {
      const owner = claimedActivities.get(activityName)
      if (owner !== undefined) {
        throw new Error(
          `Activity [${activityName}] is claimed by both workflows worker pools [${owner}] and [${pool.name}]`,
        )
      }
      claimedActivities.set(activityName, pool.name)
    }
  }

  // Selectors and implementations resolve from the same config, so an
  // unknown name is always a typo or a stale entry — with a catch-all it
  // would silently reroute the real activity there, so fail loudly.
  const registered = new Set(collectWorkflowActivityNames(workflows))
  const unknown = [...claimedActivities.keys()].filter(
    (name) => !registered.has(name),
  )
  if (unknown.length > 0) {
    throw new Error(
      `Activities [${unknown.join(', ')}] selected by workflows activity worker pools do not exist in the registered workflows`,
    )
  }

  // Without a catch-all, an activity claimed by no pool would stall its
  // workflows silently forever — fail loudly at startup instead.
  if (catchAll === undefined) {
    const uncovered = [...registered].filter(
      (name) => !claimedActivities.has(name),
    )
    if (uncovered.length > 0) {
      throw new Error(
        `Activities [${uncovered.join(', ')}] are not claimed by any workflows activity worker pool; add them to a pool or configure a catch-all pool without activityNames`,
      )
    }
  }

  return pools.map((pool) => ({
    ...normalizeWorkerPool(pool),
    name: pool.name,
    ...(pool.activityNames === undefined
      ? {}
      : { activityNames: pool.activityNames }),
  }))
}
