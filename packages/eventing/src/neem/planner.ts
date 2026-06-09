import type { MaybePromise } from '@nmtjs/common'
import { defineRuntimePlanner } from '@nmtjs/neem'

import type { EventingRuntimeConfig, EventingWorkerData } from './runtime.ts'

export function defineEventingPlanner<
  const TConfig extends EventingRuntimeConfig = EventingRuntimeConfig,
>(factory: () => MaybePromise<TConfig>) {
  return defineRuntimePlanner<undefined, EventingWorkerData>(async () => {
    const config = await factory()
    const { consumers } = config
    const workerCount = Math.min(
      consumers.length,
      normalizeThreadCount(config.threads),
    )
    const assignments = Array.from({ length: workerCount }, (): number[] => [])

    for (let index = 0; index < consumers.length; index++) {
      assignments[index % workerCount]!.push(index)
    }

    return {
      workers: assignments.map((consumerIndexes) => ({ consumerIndexes })),
    }
  })
}

function normalizeThreadCount(count: number | undefined): number {
  if (count === undefined) return 1
  return Math.max(1, Math.floor(count))
}
