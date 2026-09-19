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
      config.workers.coordinator.threads,
    )
    const execution = config.workers.execution.flatMap((pool) =>
      createWorkerData('execution', pool.threads, pool.name),
    )

    return {
      workers: { coordinator, execution },
      options: factory,
    }
  })
}

function createWorkerData(
  role: WorkflowWorkerRole,
  threads: number,
  pool?: string,
): readonly WorkflowsWorkerData[] {
  const data = pool === undefined ? { role } : { role, pool }
  return Array.from({ length: threads }, () => ({ ...data }))
}
