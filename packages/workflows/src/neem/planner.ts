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
    const coordinator = createWorkerData(
      'coordinator',
      config.workers.coordinator,
    )
    const execution: WorkflowsWorkerData[] = []

    for (const pool of config.workers.execution) {
      const threads = normalizeThreadCount('execution', pool.threads)
      for (let index = 0; index < threads; index++) {
        execution.push({ role: 'execution', pool: pool.name })
      }
    }

    return {
      workers: { coordinator, execution },
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
