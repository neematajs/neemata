import type { MaybePromise } from '@nmtjs/common'
import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'

export type SchedulerPlannerFactory<
  TConfig extends SchedulerConfig = SchedulerConfig,
> = () => MaybePromise<TConfig>

export function createSchedulerRuntime() {
  return createRuntime({ host: { entry: '@nmtjs/scheduler/neem/host' } })
}

export function defineSchedulerPlanner<
  const TConfig extends SchedulerConfig = SchedulerConfig,
>(factory: SchedulerPlannerFactory<TConfig>) {
  return defineRuntimePlanner(() => ({ workers: [], options: factory }))
}
