import type { MaybePromise } from '@nmtjs/common'
import type { NeemEntryInput, NeemRuntimeDeclaration } from '@nmtjs/neem'
import { createRuntime } from '@nmtjs/neem'

import type { EventingAdapter } from '../core/adapter.ts'
import type { AnyEventingConsumerDefinition } from '../core/consumer.ts'

export type EventingAdapterFactory = () => MaybePromise<EventingAdapter>

export type EventingConsumersFactory = () => MaybePromise<
  readonly AnyEventingConsumerDefinition[]
>

export type EventingRuntimeConfig = {
  adapter: EventingAdapterFactory
  consumers: EventingConsumersFactory
  threads?: number
}

export type EventingRuntimeConfigInput = {
  name?: string
  planner?: NeemEntryInput
  worker: NeemEntryInput
}

export type EventingWorkerData = { consumerIndexes: readonly number[] }

const defineEventingRuntimeProject = createRuntime({})

export function defineEventingRuntime(
  config: EventingRuntimeConfigInput,
): NeemRuntimeDeclaration {
  return defineEventingRuntimeProject({
    name: config.name,
    planner: config.planner,
    worker: { entry: config.worker },
  })
}

export function defineEventing(config: EventingRuntimeConfig) {
  return Object.freeze(config)
}
