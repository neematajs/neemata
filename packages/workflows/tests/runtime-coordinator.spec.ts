import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  continueWorkflowRun,
  defineWorkflow,
  implementWorkflow,
} from '../src/index.ts'
import { createInMemoryWorkflowRuntime } from '../src/testing/index.ts'

describe('workflow runtime coordinator', () => {
  it('dispatches an activity attempt, stores node input, and completes run after continuation', async () => {
    const workflow = defineWorkflow({
      name: 'case-generation',
      input: t.object({ scenario: t.string() }),
      output: t.object({ caseId: t.string() }),
    })
      .activity('content', {
        input: t.object({ scenario: t.string() }),
        output: t.object({ text: t.string() }),
      })
      .build()

    const implementation = implementWorkflow(workflow)
      .content(async (_ctx, input) => ({ text: input.scenario }), {
        input: (_ctx, _outputs, input) => ({ scenario: input.scenario }),
      })
      .finish((_ctx, { content }) => ({ caseId: content.text }))

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: { scenario: 'alpha' },
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const afterDispatch = runtime.inspect()
    expect(afterDispatch.activityCommands).toHaveLength(1)
    expect(afterDispatch.nodes[0]?.input).toStrictEqual({ scenario: 'alpha' })

    const attempt = afterDispatch.attempts[0]!
    await runtime.store.completeCurrentAttempt({
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      output: { text: 'alpha' },
    })
    await runtime.store.completeNode({
      runId: run.id,
      nodeName: 'content',
      output: { text: 'alpha' },
    })

    await continueWorkflowRun({
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
      workflows: [implementation],
      workerId: 'coordinator-1',
      command: {
        kind: 'continueRun',
        runId: run.id,
        workflowName: workflow.name,
      },
    })

    const snapshot = await runtime.store.loadRunSnapshot(run.id)
    expect(snapshot?.run.status).toBe('completed')
    expect(snapshot?.run.output).toStrictEqual({ caseId: 'alpha' })
  })
})
