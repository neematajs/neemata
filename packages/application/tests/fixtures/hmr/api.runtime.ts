import { createNeemataRuntime } from '@nmtjs/application/neem/runtime'

export default createNeemataRuntime()({
  name: 'api',
  planner: './api.planner.ts',
  worker: { entry: './api.worker.ts' },
})
