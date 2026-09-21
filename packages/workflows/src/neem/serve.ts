import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { HandlerRunner } from '../runtime/handler.ts'
import type {
  ResolvedExecutionWorkerPool,
  ResolvedWorkflowsConfig,
  WorkflowsWorkerData,
} from './runtime.ts'
import { serveExecutionWorker, serveWorkflowWorker } from '../runtime/worker.ts'

export async function runRoleLoop(input: {
  readonly data: WorkflowsWorkerData
  readonly runtime: WorkflowRuntimeAdapter
  readonly config: ResolvedWorkflowsConfig
  readonly executionPool?: ResolvedExecutionWorkerPool
  readonly handlers: HandlerRunner
  /** The typed worker definitions proved it covers every handler. */
  readonly env: unknown
  readonly workerId: string
  readonly signal: AbortSignal
  readonly onError: (error: unknown) => void
}): Promise<void> {
  const role = input.data.role
  switch (role) {
    case 'coordinator':
      await serveWorkflowWorker({
        ...input.runtime,
        handlers: input.handlers,
        env: input.env,
        workflows: input.config.workflows,
        workerId: input.workerId,
        concurrency: input.config.workers.coordinator.concurrency,
        leaseMs: input.config.workers.coordinator.leaseMs,
        idleDelayMs: input.config.workers.coordinator.pollIntervalMs,
        scheduling:
          input.config.schedules.length === 0 ? undefined : { everyMs: 1000 },
        signal: input.signal,
        onError: input.onError,
      })
      return

    case 'execution':
      await serveExecutionWorker({
        ...input.runtime,
        handlers: input.handlers,
        env: input.env,
        workflows: input.config.workflows,
        tasks: input.config.tasks,
        activityNames: input.executionPool!.activityNames,
        taskNames: input.executionPool!.taskNames,
        workerId: input.workerId,
        concurrency: input.executionPool!.concurrency,
        leaseMs: input.executionPool!.leaseMs,
        idleDelayMs: input.executionPool!.pollIntervalMs,
        // Coordinators own maintenance so execution capacity is not duplicated
        // across every named pool and thread.
        reaping: false,
        signal: input.signal,
        onError: input.onError,
      })
      return
  }
}

export function resolveExecutionWorkerPool(
  config: ResolvedWorkflowsConfig,
  data: WorkflowsWorkerData,
): ResolvedExecutionWorkerPool {
  const pools = config.workers.execution
  if (data.pool !== undefined) {
    const pool = pools.find((candidate) => candidate.name === data.pool)
    if (!pool) {
      throw new Error(`Unknown workflows execution worker pool [${data.pool}]`)
    }
    return pool
  }
  // Hand-written worker data can omit a name only when routing is unambiguous.
  if (pools.length === 1) return pools[0]!
  throw new Error(
    'Workflows execution worker data must name a pool when multiple execution pools are configured',
  )
}
