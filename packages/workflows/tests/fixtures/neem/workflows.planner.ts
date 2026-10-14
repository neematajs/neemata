import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { pollMs: 20 },
  pools: { io: { pollMs: 20 }, heavy: { threads: 2, pollMs: 20 } },
}))
