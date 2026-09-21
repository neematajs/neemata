import { defineWorkflowsWorker } from '@nmtjs/workflows/effect/neem'
import { createInMemoryWorkflowRuntime } from '@nmtjs/workflows/runtime'
import * as Effect from 'effect/Effect'

import { record } from './events.ts'
import { marker } from './marker.ts'
import { nextGeneration } from './state.ts'

export default defineWorkflowsWorker({
  workflows: () => [],
  runtime: Effect.acquireRelease(
    Effect.sync(() => {
      const generation = nextGeneration()
      record({ event: 'workflows:start', generation, marker })
      return { ...createInMemoryWorkflowRuntime(), generation }
    }),
    ({ generation }) =>
      Effect.sync(() => {
        record({ event: 'workflows:stop', generation, marker })
      }),
  ),
})
