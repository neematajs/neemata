import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

import type { MaybePromise } from '../types/index.ts'
import type {
  ResolvedWorkflowsPlan,
  WorkflowsPlan,
  WorkflowsWorkerData,
} from './runtime.ts'
import { resolveWorkflowsPlan } from './runtime.ts'

export function createWorkflowsRuntime() {
  return createRuntime({ host: { entry: '@nmtjs/workflows/neem/host' } })
}

/**
 * Decides the thread layout on the main thread without loading application
 * code: every worker receives its loop settings and the declared pool names.
 */
export function defineWorkflowsPlanner(
  factory: () => MaybePromise<WorkflowsPlan>,
) {
  return defineRuntimePlanner<ResolvedWorkflowsPlan, WorkflowsWorkerData>(
    async () => {
      const plan = resolveWorkflowsPlan(await factory())
      const pools = Object.keys(plan.pools)
      const { threads, ...settings } = plan.coordinator
      const coordinator = Array.from(
        { length: threads },
        (): WorkflowsWorkerData => ({ role: 'coordinator', settings, pools }),
      )
      const execution = Object.entries(plan.pools).flatMap(
        ([pool, { threads, ...settings }]) =>
          Array.from(
            { length: threads },
            (): WorkflowsWorkerData => ({
              role: 'execution',
              pool,
              settings,
              pools,
            }),
          ),
      )
      return { workers: { coordinator, execution }, options: plan }
    },
  )
}
