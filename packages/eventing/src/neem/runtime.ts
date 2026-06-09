import type { MaybePromise } from '@nmtjs/common'

import type { EventingAdapter } from '../core/adapter.ts'
import type { EventingConsumers } from '../core/consumer.ts'

export type EventingAdapterFactory = () => MaybePromise<EventingAdapter>

export type EventingRuntimeConfig = {
  adapter: EventingAdapterFactory
  consumers: EventingConsumers
  threads?: number
}

export type EventingWorkerData = { consumerIndexes: readonly number[] }

export function defineEventing(config: EventingRuntimeConfig) {
  return Object.freeze(config)
}
