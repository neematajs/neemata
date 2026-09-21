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
import {
  collectChildWorkflowNames,
  collectImplementationPools,
  collectWorkflowTaskNames,
  findConflictingDefinitions,
} from '../runtime/worker.ts'

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

/**
 * Instantiates what this thread serves and checks it is complete. A gap would
 * otherwise leave durable commands stalled forever, so it fails startup instead.
 */
export async function resolveWorkflowsRegistry(
  registry: WorkflowsRegistry,
  data: WorkflowsWorkerData,
): Promise<ResolvedWorkflowsRegistry> {
  // The same implementation may arrive through several module lists.
  const workflows = [...new Set(await registry.workflows())]
  const tasks = [...new Set((await registry.tasks?.()) ?? [])]
  const schedules = (await registry.schedules?.()) ?? []

  // The execution registry refuses a second implementation of a name only when
  // it is built, at claim time, where it would fail unrelated work as well.
  const duplicates = [
    ...findDuplicateNames(
      'workflow',
      workflows.map(({ workflow }) => workflow.name),
    ),
    ...findDuplicateNames(
      'task',
      tasks.map(({ task }) => task.name),
    ),
  ]
  if (duplicates.length > 0) {
    throw new Error(
      `Implementations [${duplicates.join(', ')}] are registered more than once; a workflow or task takes exactly one implementation`,
    )
  }

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

  // A schedule starts its target by name as well: an unregistered one would
  // fire runs nobody can claim, and a same-named copy would encode its input
  // with another schema than the implementation decodes with.
  const registered = {
    workflow: new Map(
      workflows.map(({ workflow }) => [workflow.name, workflow]),
    ),
    task: new Map(tasks.map(({ task }) => [task.name, task])),
  }
  const targets = schedules.map(({ runnable }) => ({
    runnable,
    registered: registered[runnable.kind].get(runnable.name),
  }))
  const missingTargets = targets.filter((target) => !target.registered)
  if (missingTargets.length > 0) {
    const names = new Set(missingTargets.map(({ runnable }) => runnable.name))
    throw new Error(
      `Workflows or tasks [${[...names].join(', ')}] targeted by schedules have no registered implementation`,
    )
  }

  const conflicts = [
    ...new Set([
      ...findConflictingDefinitions(workflows, tasks),
      ...targets
        .filter((target) => target.registered !== target.runnable)
        .map(({ runnable }) => runnable.name),
    ]),
  ]
  if (conflicts.length > 0) {
    throw new Error(
      `Definitions [${conflicts.join(', ')}] exist as more than one object; a reference and its registered implementation must share one definition`,
    )
  }

  // Hand-written worker data without the planner's pools skips this check.
  if (data.pools) {
    const declared = new Set(data.pools)
    const undeclared = [...collectImplementationPools(workflows, tasks)].filter(
      (pool) => !declared.has(pool),
    )
    if (undeclared.length > 0) {
      throw new Error(
        `Execution pools [${undeclared.join(', ')}] named by implementations are not declared by the workflows planner`,
      )
    }
  }

  return { workflows, tasks, schedules }
}

function findDuplicateNames(
  kind: 'workflow' | 'task',
  names: readonly string[],
) {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const name of names) {
    if (seen.has(name)) duplicates.add(`${kind}:${name}`)
    seen.add(name)
  }
  return duplicates
}
