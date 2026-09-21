import { describe } from 'vitest'

import { createInMemoryWorkflowRuntime } from '../src/runtime/index.ts'
import { defineClaimFencingTests } from './support/fencing.ts'

describe('in-memory settlement fencing by the queue claim', () => {
  defineClaimFencingTests((options) => createInMemoryWorkflowRuntime(options))
})
