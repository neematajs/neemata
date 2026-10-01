import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type {
  AnyScheduleDefinition,
  AnyWorkflowDefinition,
  AnyTaskDefinition,
  MaybePromise,
} from '../types/index.ts'
import { verifyWorkflowsRegistry } from '../runtime/worker.ts'

export type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>
export type AnyTaskImplementation = TaskImplementation<AnyTaskDefinition, any>

export type WorkflowWorkerRole = 'coordinator' | 'execution'

/** How one worker thread runs its loop. */
export type WorkflowsWorkerSettings = {
  readonly concurrency: number
  readonly leaseMs: number
  readonly pollIntervalMs: number
  readonly cleanupTimeoutMs: number
}

export type WorkflowsPoolConfig = Partial<WorkflowsWorkerSettings> & {
  readonly threads?: number
}

/**
 * The deployment's thread layout, owned by the planner. Implementations choose
 * a pool by name; its size and timing are decided here, per environment.
 */
export type WorkflowsPlan = {
  readonly coordinator?: WorkflowsPoolConfig
  /** Every execution pool an implementation names, by name. */
  readonly pools: Readonly<Record<string, WorkflowsPoolConfig>>
}

export type WorkflowsWorkerData = {
  readonly role: WorkflowWorkerRole
  /** The pool an execution worker serves; every pool when omitted. */
  readonly pool?: string
  readonly settings?: Partial<WorkflowsWorkerSettings>
  /** Pools the planner declared, to reject implementations that name another. */
  readonly pools?: readonly string[]
}

/** What a worker thread serves. Only the worker reads it. */
export type WorkflowsRegistry<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
  T extends AnyTaskImplementation = AnyTaskImplementation,
  S extends AnyScheduleDefinition = AnyScheduleDefinition,
> = {
  readonly workflows: () => MaybePromise<readonly W[]>
  readonly tasks?: () => MaybePromise<readonly T[]>
  readonly schedules?: () => MaybePromise<readonly S[]>
}

export type ResolvedWorkflowsRegistry = {
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly tasks: readonly AnyTaskImplementation[]
  readonly schedules: readonly AnyScheduleDefinition[]
}

const defaultSettings: WorkflowsWorkerSettings = {
  concurrency: 1,
  leaseMs: 30_000,
  pollIntervalMs: 250,
  cleanupTimeoutMs: 5_000,
}

export function resolveWorkerSettings(
  settings: Partial<WorkflowsWorkerSettings> | undefined,
): WorkflowsWorkerSettings {
  return { ...defaultSettings, ...settings }
}

export type ResolvedWorkflowsPlan = {
  readonly coordinator: WorkflowsWorkerSettings & { readonly threads: number }
  readonly pools: Readonly<
    Record<string, WorkflowsWorkerSettings & { readonly threads: number }>
  >
}

export function resolveWorkflowsPlan(
  plan: WorkflowsPlan,
): ResolvedWorkflowsPlan {
  const pools = Object.entries(plan.pools)
  // Nothing is placed implicitly, so a layout without pools runs no handlers.
  if (pools.length === 0)
    throw new Error(
      'Workflows planner must declare at least one execution pool',
    )
  return {
    coordinator: resolvePool('coordinator', plan.coordinator),
    pools: Object.fromEntries(
      pools.map(([name, config]) => {
        if (!name) throw new Error('Workflows execution pool requires a name')
        return [name, resolvePool(`execution pool [${name}]`, config)]
      }),
    ),
  }
}

function resolvePool(label: string, config: WorkflowsPoolConfig | undefined) {
  const { threads = 1, ...settings } = config ?? {}
  if (!Number.isInteger(threads) || threads < 1) {
    throw new Error(
      `Invalid workflows worker thread count for ${label}: expected positive integer, received ${threads}`,
    )
  }
  return { threads, ...resolveWorkerSettings(settings) }
}

/** Instantiates what this thread serves and fails startup when it is incomplete. */
export async function resolveWorkflowsRegistry(
  registry: WorkflowsRegistry,
  data: WorkflowsWorkerData,
): Promise<ResolvedWorkflowsRegistry> {
  // The same implementation may arrive through several module lists.
  const workflows = [...new Set(await registry.workflows())]
  const tasks = [...new Set((await registry.tasks?.()) ?? [])]
  const schedules = (await registry.schedules?.()) ?? []
  verifyWorkflowsRegistry({
    workflows,
    tasks,
    schedules,
    // Hand-written worker data without the planner's pools skips this check.
    pools: data.pools,
  })
  return { workflows, tasks, schedules }
}
