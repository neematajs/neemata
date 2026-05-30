import type { MaybePromise } from '@nmtjs/common'
import type { NeemEntryInput, NeemRuntimeConfigBase } from '@nmtjs/neem'
import { defineRuntime } from '@nmtjs/neem'

import type { EventingAdapter } from '../core/adapter.ts'
import type { AnyEventingConsumerDefinition } from '../core/consumer.ts'

export type EventingAdapterFactory = () => MaybePromise<EventingAdapter>

export type EventingConsumersFactory = () => MaybePromise<
  readonly AnyEventingConsumerDefinition[]
>

export type EventingRuntimeConfig = {
  adapter: EventingAdapterFactory
  consumers: EventingConsumersFactory
}

export type EventingRuntimeConfigInput = {
  config: NeemEntryInput
  threads?: number
}

export function defineEventingRuntime<
  const TConfig extends EventingRuntimeConfig = EventingRuntimeConfig,
>(config: { config: NeemEntryInput; threads?: number }): NeemRuntimeConfigBase {
  return defineRuntime({
    worker: { entry: eventingWorkerEntry },
    artifacts: [
      { id: eventingConfigArtifactId, kind: 'module', entry: config.config },
    ],
    threads: config.threads ?? 1,
  })
}

export function defineEventing(config: EventingRuntimeConfig) {
  return Object.freeze(config)
}

export const eventingConfigArtifactId = 'eventing-config'

export const eventingWorkerEntry = '@nmtjs/eventing/neem/worker-entry'
