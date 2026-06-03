import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './api.planner.ts',
  worker: { entry: '../../shared/workers/http-runtime.ts' },
})
