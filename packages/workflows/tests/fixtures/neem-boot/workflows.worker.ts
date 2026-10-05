import { defineWorkflowsWorker } from '@nmtjs/workflows/neem'
import { createInMemoryWorkflowRuntime } from '@nmtjs/workflows/runtime'

import { registry } from './registry.ts'

export default defineWorkflowsWorker({
  ...registry,
  setup: () => ({ runtime: createInMemoryWorkflowRuntime() }),
})
