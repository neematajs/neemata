import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'aux',
  planner: './aux.planner.ts',
  worker: { entry: './aux.worker.ts' },
})
