import { defineRuntime } from '../../neem.ts'

export default defineRuntime({
  name: 'legacy',
  planner: './neem.planner.ts',
  worker: { entry: '../../../../shared/workers/runtime-app.ts' },
})
