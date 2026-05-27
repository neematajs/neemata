import type {
  NeemEntryInput,
  NeemMaybePromise,
  NeemRuntimeFactory,
} from '@nmtjs/neem'
import { defineRuntime } from '@nmtjs/neem'

import type { EventingAdapter } from '../core/adapter.ts'
import type { AnyEventingConsumerDefinition } from '../core/consumer.ts'

export type EventingAdapterFactory = () => NeemMaybePromise<EventingAdapter>

export type EventingConsumersFactory = () => NeemMaybePromise<
  readonly AnyEventingConsumerDefinition[]
>

export type EventingRuntimeConfig = {
  adapter: EventingAdapterFactory
  consumers: EventingConsumersFactory
}

export type EventingRuntimeConfigInput = {
  config: NeemEntryInput<EventingRuntimeConfig>
  threads?: number
}

export function defineEventingRuntime<
  const TConfig extends EventingRuntimeConfig = EventingRuntimeConfig,
>(config: {
  config: NeemEntryInput<TConfig>
  threads?: number
}): NeemRuntimeFactory {
  return defineRuntime({
    entry: eventingWorkerEntry,
    threads: config.threads ?? 1,
    build: {
      artifacts: [
        { id: eventingConfigArtifactId, kind: 'module', entry: config.config },
      ],
    },
  })
}

export function defineEventing(config: EventingRuntimeConfig) {
  return Object.freeze(config)
}

export const eventingConfigArtifactId = 'eventing-config'

export const eventingWorkerEntry = '@nmtjs/eventing/neem/worker-entry'
