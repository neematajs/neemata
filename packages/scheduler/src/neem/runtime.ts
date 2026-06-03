import type { MaybePromise } from '@nmtjs/common'
import type { NeemEntryInput, NeemRuntimeDeclaration } from '@nmtjs/neem'
import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'

export type SchedulerRuntimeConfigInput = {
  name?: string
  planner?: NeemEntryInput
}

export type SchedulerPlannerFactory<
  TConfig extends SchedulerConfig = SchedulerConfig,
> = () => MaybePromise<TConfig>

const defineSchedulerRuntimeProject = createRuntime({
  host: { entry: '@nmtjs/scheduler/neem/host' },
})

export function defineSchedulerRuntime(
  config: SchedulerRuntimeConfigInput = {},
): NeemRuntimeDeclaration {
  return defineSchedulerRuntimeProject({
    name: config.name,
    planner: config.planner,
  })
}

export function defineSchedulerPlanner<
  const TConfig extends SchedulerConfig = SchedulerConfig,
>(factory: SchedulerPlannerFactory<TConfig>) {
  return defineRuntimePlanner(() => ({ workers: [], options: factory }))
}
