import type { NeemEntryInput, NeemRuntimeConfigBase } from '@nmtjs/neem'
import { defineRuntime } from '@nmtjs/neem'

import type { SchedulerConfig } from '../scheduler.ts'

export const schedulerConfigArtifactId = 'scheduler-config'

export type SchedulerRuntimeConfigInput<
  _TConfig extends SchedulerConfig = SchedulerConfig,
> = { config: NeemEntryInput }

export function defineSchedulerRuntime<
  const TConfig extends SchedulerConfig = SchedulerConfig,
>(config: SchedulerRuntimeConfigInput<TConfig>): NeemRuntimeConfigBase {
  return defineRuntime({
    host: { entry: '@nmtjs/scheduler/neem/host' },
    threads: 0,
    artifacts: [
      { id: schedulerConfigArtifactId, kind: 'module', entry: config.config },
    ],
  })
}
