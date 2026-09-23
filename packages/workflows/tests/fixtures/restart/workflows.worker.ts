import { defineWorkflowsWorker } from '@nmtjs/workflows/neem'
import { createInMemoryWorkflowRuntime } from '@nmtjs/workflows/runtime'

import { record } from './events.ts'
import { marker } from './marker.ts'
import { nextGeneration } from './state.ts'

export default defineWorkflowsWorker({
  workflows: () => [],
  setup() {
    const generation = nextGeneration()
    record({ event: 'workflows:start', generation, marker })
    return {
      runtime: createInMemoryWorkflowRuntime(),
      dispose() {
        record({ event: 'workflows:stop', generation, marker })
      },
    }
  },
})
