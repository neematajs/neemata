import { defineWorkflowsWorker } from '@nmtjs/workflows/effect/neem'
import { createInMemoryWorkflowRuntime } from '@nmtjs/workflows/runtime'
import * as Effect from 'effect/Effect'

import { registry } from './registry.ts'

export default defineWorkflowsWorker({
  ...registry,
  runtime: Effect.sync(() => createInMemoryWorkflowRuntime()),
})
