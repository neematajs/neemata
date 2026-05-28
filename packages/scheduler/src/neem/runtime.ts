import type { NeemEntryInput, NeemRuntimeConfigBase } from '@nmtjs/neem'
import { defineRuntime } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'

export type SchedulerRuntimeConfigInput<
  TConfig extends SchedulerConfig = SchedulerConfig,
> = { config: NeemEntryInput }

export function defineSchedulerRuntime<
  const TConfig extends SchedulerConfig = SchedulerConfig,
>(config: SchedulerRuntimeConfigInput<TConfig>): NeemRuntimeConfigBase {
  return defineRuntime({
    worker: { entry: config.config },
    host: { entry: '@nmtjs/scheduler/neem/host' },
  })
}
