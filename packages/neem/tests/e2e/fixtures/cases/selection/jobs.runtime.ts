import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'jobs',
  planner: './jobs.planner.ts',
  worker: { entry: '../../shared/workers/selection-runtime.ts' },
})
