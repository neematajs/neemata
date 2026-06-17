import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './api.planner.ts',
  worker: { entry: './reload-start-failure.worker.ts' },
})
