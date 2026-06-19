import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './api.planner.ts',
  proxy: { routing: { type: 'default' } },
  worker: { entry: '../../shared/workers/http-runtime.ts' },
})
