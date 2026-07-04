import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'consumer',
  planner: './api.planner.ts',
  worker: { entry: './api.worker.ts' },
})
