import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'api',
  planner: './duplicate.planner.ts',
  worker: { entry: '../../shared/workers/generic-runtime.ts' },
})
