import { defineWorkflowsPlanner } from '@nmtjs/workflows/neem'

export default defineWorkflowsPlanner(() => ({
  coordinator: { leaseMs: 600, pollIntervalMs: 10 },
  pools: {
    default: {
      concurrency: 2,
      leaseMs: 600,
      pollIntervalMs: 10,
      cleanupTimeoutMs: 50,
    },
  },
}))
