import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

import type {
  WorkflowsConfig,
  WorkflowsWorkerData,
  WorkflowWorkerRole,
} from './runtime.ts'
import { resolveWorkflowsConfig } from './runtime.ts'

export function createWorkflowsRuntime() {
  return createRuntime({ host: { entry: '@nmtjs/workflows/neem/host' } })
}

export function defineWorkflowsPlanner<
  const TConfig extends WorkflowsConfig = WorkflowsConfig,
>(factory: () => TConfig | Promise<TConfig>) {
  return defineRuntimePlanner<typeof factory, WorkflowsWorkerData>(async () => {
    const config = await resolveWorkflowsConfig(await factory())

    return {
      workers: {
        coordinator: createWorkerData(
          'coordinator',
          config.workers.coordinator,
        ),
        execution: config.workers.execution.flatMap((pool) =>
          Array.from(
            { length: normalizeThreadCount('execution', pool.threads) },
            (): WorkflowsWorkerData => ({
              role: 'execution',
              pool: pool.name,
            }),
          ),
        ),
      },
      options: factory,
    }
  })
}

function createWorkerData(
  role: WorkflowWorkerRole,
  config: { readonly threads: number },
): readonly WorkflowsWorkerData[] {
  const threads = normalizeThreadCount(role, config.threads)
  return Array.from({ length: threads }, () => ({ role }))
}

function normalizeThreadCount(role: WorkflowWorkerRole, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `Invalid workflows worker thread count for ${role}: expected positive integer, received ${value}`,
    )
  }
  return value
}
