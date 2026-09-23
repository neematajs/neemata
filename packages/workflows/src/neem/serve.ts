import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { HandlerRunner } from '../runtime/handler.ts'
import type {
  ResolvedWorkflowsRegistry,
  WorkflowsWorkerData,
  WorkflowsWorkerSettings,
} from './runtime.ts'
import { serveExecutionWorker, serveWorkflowWorker } from '../runtime/worker.ts'

export async function runRoleLoop(input: {
  readonly data: WorkflowsWorkerData
  readonly settings: WorkflowsWorkerSettings
  readonly runtime: WorkflowRuntimeAdapter
  readonly registry: ResolvedWorkflowsRegistry
  readonly handlers: HandlerRunner
  /** The typed worker definitions proved it covers every handler. */
  readonly env: unknown
  readonly workerId: string
  readonly signal: AbortSignal
  readonly onError: (error: unknown) => void
}): Promise<void> {
  const loop = {
    ...input.runtime,
    handlers: input.handlers,
    env: input.env,
    workflows: input.registry.workflows,
    workerId: input.workerId,
    concurrency: input.settings.concurrency,
    leaseMs: input.settings.leaseMs,
    idleDelayMs: input.settings.pollIntervalMs,
    signal: input.signal,
    onError: input.onError,
  }
  switch (input.data.role) {
    case 'coordinator':
      await serveWorkflowWorker({
        ...loop,
        scheduling:
          input.registry.schedules.length === 0 ? undefined : { everyMs: 1000 },
      })
      return

    case 'execution':
      await serveExecutionWorker({
        ...loop,
        tasks: input.registry.tasks,
        pool: input.data.pool,
        // Coordinators own maintenance so execution capacity is not duplicated
        // across every pool and thread.
        reaping: false,
      })
      return
  }
}
