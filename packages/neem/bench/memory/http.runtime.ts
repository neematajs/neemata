import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'http',
  planner: './planner.ts',
  worker: { entry: './worker.ts' },
})
