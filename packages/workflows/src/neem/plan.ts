import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

import type { ExecutionOptions, MaintenanceOptions } from '../worker/index.ts'
import type { PoolOptions } from '../worker/pool.ts'

type Threads = {
  /** Worker threads; 1 when omitted. */
  readonly threads?: number
}

/**
 * The threads that advance runs and run the engine's maintenance. Neem
 * copies a plan to its threads as data, so it holds settings only: the
 * schedules themselves are declarations, with schemas and functions, and are
 * registered with the worker, which every thread loads for itself.
 */
export type CoordinatorPlan = Threads &
  PoolOptions &
  Omit<MaintenanceOptions, 'schedules'>

/** The threads that run the handlers of one pool. */
export type PoolPlan = Threads & PoolOptions & ExecutionOptions

/**
 * The deployment's thread layout. Declarations choose a pool by name; its
 * size and timing are decided here, per environment.
 */
export type WorkflowsPlan = {
  readonly coordinator?: CoordinatorPlan
  /** Every pool a declaration names, by name. */
  readonly pools: Readonly<Record<string, PoolPlan>>
}

/** What a worker thread is told: its role, and the pools that were planned. */
export type WorkerData = {
  /** To refuse declarations that name a pool no thread serves. */
  readonly pools: readonly string[]
} & (
  | {
      readonly role: 'coordinator'
      readonly options: Omit<CoordinatorPlan, 'threads'>
    }
  | {
      readonly role: 'execution'
      readonly pool: string
      readonly options: Omit<PoolPlan, 'threads'>
    }
)

/** One entry of worker data for each thread of a plan. */
function replicate<Plan extends Threads>(
  label: string,
  { threads = 1, ...options }: Plan,
  data: (options: Omit<Plan, 'threads'>) => WorkerData,
): WorkerData[] {
  if (!Number.isInteger(threads) || threads < 1) {
    throw new Error(
      `Invalid workflows worker thread count for ${label}: expected positive integer, received ${threads}`,
    )
  }
  return Array.from({ length: threads }, () => data(options))
}

/** A Neem runtime of workflow workers; it names its planner and worker. */
export const createWorkflowsRuntime = createRuntime({})

/**
 * Decides the thread layout on the main thread, without loading application
 * code. Options are handed to the workers as they are: each worker checks
 * its own when it starts, before it acquires anything.
 */
export function defineWorkflowsPlanner(
  factory: () => WorkflowsPlan | Promise<WorkflowsPlan>,
) {
  return defineRuntimePlanner<undefined, WorkerData>(async () => {
    const plan = await factory()
    const pools = Object.keys(plan.pools)
    // Nothing is placed implicitly, so a layout without pools runs no handlers.
    if (pools.length === 0) {
      throw new Error(
        'Workflows planner must declare at least one execution pool',
      )
    }
    if (pools.includes('')) {
      throw new Error('Workflows execution pool requires a name')
    }
    // Types rule it out; an untyped plan gets this instead of a failed copy.
    if (plan.coordinator && 'schedules' in plan.coordinator) {
      throw new Error(
        'Workflows planner takes no schedules: register them with defineWorkflowsWorker({ schedules })',
      )
    }

    return {
      workers: {
        coordinator: replicate(
          'coordinator',
          plan.coordinator ?? {},
          (options) => ({ role: 'coordinator', options, pools }),
        ),
        execution: Object.entries(plan.pools).flatMap(([pool, config]) =>
          replicate(`execution pool [${pool}]`, config, (options) => ({
            role: 'execution',
            pool,
            options,
            pools,
          })),
        ),
      },
    }
  })
}
