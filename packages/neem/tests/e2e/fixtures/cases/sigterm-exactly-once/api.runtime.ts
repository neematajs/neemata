import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './api.planner.ts',
  worker: { entry: './api.worker.ts' },
  host: { entry: './api.host.ts' },
})
