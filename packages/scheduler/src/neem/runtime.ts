import type { NeemEntryInput, NeemRuntimeFactory } from '@nmtjs/neem'
import { defineRuntime } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'

export type SchedulerRuntimeConfigInput<
  TConfig extends SchedulerConfig = SchedulerConfig,
> = { config: NeemEntryInput<TConfig> }

export function defineSchedulerRuntime<
  const TConfig extends SchedulerConfig = SchedulerConfig,
>(config: SchedulerRuntimeConfigInput<TConfig>): NeemRuntimeFactory {
  return defineRuntime({
    entry: config.config,
    build: { host: { entry: '@nmtjs/scheduler/neem/host' } },
  })
}
