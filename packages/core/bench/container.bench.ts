import { bench, describe } from 'vitest'

import {
  Container,
  createFactoryInjectable,
  createLogger,
  Scope,
} from '../src/index.ts'

const BENCHMARK_OPTIONS = {
  time: 200,
  warmupTime: 50,
  iterations: 20,
  warmupIterations: 5,
} as const
const CACHED_RESOLUTIONS_PER_SAMPLE = 1_000

const logger = createLogger({ pinoOptions: { enabled: false } }, 'benchmark')

const dependency = createFactoryInjectable(
  () => Object.freeze({ value: 41 }),
  'benchmark dependency',
)
const injectable = createFactoryInjectable(
  {
    dependencies: { dependency },
    create: ({ dependency }) => Object.freeze({ value: dependency.value + 1 }),
  },
  'benchmark service',
)
const transientInjectable = createFactoryInjectable(
  {
    dependencies: { dependency },
    scope: Scope.Transient,
    create: ({ dependency }) => Object.freeze({ value: dependency.value + 1 }),
  },
  'benchmark transient service',
)

const cachedContainer = new Container({ logger })
await cachedContainer.resolve(injectable)

const transientContainer = new Container({ logger })
await transientContainer.resolve(dependency)

let coldContainers: Container[] = []
let coldContainerIndex = 0

describe('dependency injection resolution', () => {
  bench(
    `${CACHED_RESOLUTIONS_PER_SAMPLE} cached factory resolutions`,
    async () => {
      for (let index = 0; index < CACHED_RESOLUTIONS_PER_SAMPLE; index += 1) {
        await cachedContainer.resolve(injectable)
      }
    },
    BENCHMARK_OPTIONS,
  )

  bench(
    'cold factory',
    async () => {
      const container = coldContainers[coldContainerIndex]
      coldContainerIndex += 1
      await container!.resolve(injectable)
    },
    {
      time: 0,
      warmupTime: 0,
      iterations: 1_000,
      warmupIterations: 100,
      setup: (_task, mode) => {
        const count = mode === 'warmup' ? 100 : 1_000
        coldContainers = Array.from(
          { length: count },
          () => new Container({ logger }),
        )
        coldContainerIndex = 0
      },
    },
  )

  bench(
    'transient factory',
    async () => {
      await transientContainer.resolve(transientInjectable)
    },
    BENCHMARK_OPTIONS,
  )
})
