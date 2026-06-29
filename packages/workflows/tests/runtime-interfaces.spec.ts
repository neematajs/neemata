import { describe, expectTypeOf, it } from 'vitest'

import type {
  AttemptCommand,
  AttemptExecutor,
  ContinueRunCommand,
  RunCoordinationExecutor,
  StoredAttempt,
  StoredNode,
  StoredRun,
  WorkflowStore,
} from '../src/index.ts'

describe('workflow runtime interfaces', () => {
  it('exports adapter-free runtime contracts from the root package', () => {
    expectTypeOf<ContinueRunCommand>().toMatchTypeOf<{
      kind: 'continueRun'
      runId: string
      workflowName: string
    }>()

    expectTypeOf<AttemptCommand>().toMatchTypeOf<{
      attemptId: string
      leaseToken: string
      workflowName: string
      runId: string
      nodeName: string
    }>()

    expectTypeOf<RunCoordinationExecutor>().toHaveProperty('enqueue')
    expectTypeOf<AttemptExecutor>().toHaveProperty('dispatchActivity')
    expectTypeOf<WorkflowStore>().toHaveProperty('createRun')
    expectTypeOf<StoredRun>().toHaveProperty('status')
    expectTypeOf<StoredNode>().toHaveProperty('status')
    expectTypeOf<StoredAttempt>().toHaveProperty('status')
  })
})
