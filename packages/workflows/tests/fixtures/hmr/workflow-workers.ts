import type { WorkflowsWorkersConfig } from '@nmtjs/workflows/neem'

export default {
  coordinator: { pollIntervalMs: 5 },
  execution: { pollIntervalMs: 5 },
} satisfies WorkflowsWorkersConfig
