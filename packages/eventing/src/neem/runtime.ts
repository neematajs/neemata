import type { MaybePromise } from '@nmtjs/common'
import type {
  NeemEntryInput,
  NeemRuntimeDeclaration,
  NeemRuntimePlan,
} from '@nmtjs/neem'
import { createRuntime, defineRuntimePlanner } from '@nmtjs/neem'

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

export function defineEventingPlanner<
  const TConfig extends EventingRuntimeConfig = EventingRuntimeConfig,
>(factory: () => MaybePromise<TConfig>) {
  return defineRuntimePlanner(
    async (): Promise<NeemRuntimePlan<unknown, EventingWorkerData>> => {
      const config = await factory()
      const consumers = await config.consumers()
      const workerCount = Math.min(
        consumers.length,
        normalizeThreadCount(config.threads),
      )
      const assignments = Array.from(
        { length: workerCount },
        (): number[] => [],
      )

      for (let index = 0; index < consumers.length; index++) {
        assignments[index % workerCount]!.push(index)
      }

      return {
        workers: assignments.map((consumerIndexes) => ({ consumerIndexes })),
      }
    },
  )
}

function normalizeThreadCount(count: number | undefined): number {
  if (count === undefined) return 1
  return Math.max(1, Math.floor(count))
}
