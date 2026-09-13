import { createPlugin, ExecutionEnvironmentLifecycleHook } from '@nmtjs/core'
import { defineWorkflows, defineWorkflowsWorker } from '@nmtjs/workflows/neem'
import { createInMemoryWorkflowRuntime } from '@nmtjs/workflows/runtime'

import { record } from './events.ts'
import { marker } from './marker.ts'
import { nextGeneration } from './state.ts'
import workers from './workflow-workers.ts'

const config = defineWorkflows({
  runtime: () => createInMemoryWorkflowRuntime(),
  workflows: () => [],
  workers,
  plugins: [
    createPlugin({
      name: 'hmr-probe',
      hooks: {
        [ExecutionEnvironmentLifecycleHook.Start]: () => {
          record({
            event: 'workflows:start',
            generation: nextGeneration(),
            marker,
          })
        },
        [ExecutionEnvironmentLifecycleHook.Stop]: () => {
          record({ event: 'workflows:stop', marker })
        },
      },
    }),
  ],
})

export default defineWorkflowsWorker(config)
