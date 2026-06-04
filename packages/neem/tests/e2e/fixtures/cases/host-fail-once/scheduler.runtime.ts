import { defineRuntime } from '@nmtjs/neem'

export default defineRuntime({
  name: 'scheduler',
  planner: './scheduler.planner.ts',
  host: { entry: './scheduler.host.ts' },
})
