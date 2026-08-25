import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

import type {
  WorkflowsConfig,
  WorkflowsWorkerData,
  WorkflowsWorkersConfig,
  WorkflowWorkerRole,
} from './runtime.ts'
import {
  resolveWorkflowsConfig,
  resolveWorkflowsWorkerTopology,
} from './runtime.ts'

export function createWorkflowsRuntime() {
  return createRuntime({ host: { entry: '@nmtjs/workflows/neem/host' } })
}

export function defineWorkflowsPlanner<
  const TInput extends WorkflowsPlannerInput = WorkflowsPlannerInput,
>(factory: () => TInput | Promise<TInput>) {
  return defineRuntimePlanner<typeof factory, WorkflowsWorkerData>(async () => {
    const input = await factory()
    const workers = isWorkflowsConfig(input)
      ? (await resolveWorkflowsConfig(input)).workers
      : resolveWorkflowsWorkerTopology(input)

    return {
      workers: {
        coordinator: createWorkerData('coordinator', workers.coordinator),
        execution: workers.execution.flatMap((pool) =>
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

export type WorkflowsPlannerInput =
  | WorkflowsConfig
  | WorkflowsWorkersConfig
  | undefined

function isWorkflowsConfig(
  input: WorkflowsPlannerInput,
): input is WorkflowsConfig {
  return Boolean(input && 'runtime' in input && 'workflows' in input)
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
