import type { NeemEntryInput, NeemMaybePromise } from '@nmtjs/neem'
import { defineRuntimeConfig, kNeemRuntimeBuild } from '@nmtjs/neem'

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
  entry: NeemEntryInput<EventingRuntimeConfig>
  threads?: number
}

export function defineEventingRuntime(config: EventingRuntimeConfigInput) {
  return defineRuntimeConfig({
    entry: eventingWorkerEntry,
    threads: config.threads ?? 1,
    [kNeemRuntimeBuild]: {
      artifacts: [
        { id: eventingConfigArtifactId, kind: 'module', entry: config.entry },
      ],
    },
  })
}

export function defineEventing(config: EventingRuntimeConfig) {
  return Object.freeze(config)
}

export const eventingConfigArtifactId = 'eventing-config'

export const eventingWorkerEntry = '@nmtjs/eventing/neem/worker-entry'
