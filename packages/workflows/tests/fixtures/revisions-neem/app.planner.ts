import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

const fast = { leaseMs: 600, pollIntervalMs: 10 }

// Each revision is placed on its own pool, so a revision is also a route to
// different threads.
export default defineWorkflowsPlanner(() => ({
  coordinator: fast,
  pools: { io: fast, heavy: fast },
}))
