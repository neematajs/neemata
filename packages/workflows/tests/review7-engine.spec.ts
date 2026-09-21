import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

describe('activity attempt of a cancelling run', () => {
  it('does not run the handler once cancellation was requested', async () => {
    const workflow = defineWorkflow({
      name: 'review7.cancelling',
      input: z.string(),
      output: z.string(),
    })
      .activity('step', { input: z.string(), output: z.string() })
      .build()
    let calls = 0
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .step((input) => {
        calls++
        return input
      })
      .finish(({ step }) => step)
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [],
      workerId: 'review7',
    }

    const run = await client.start(workflow, 'hi')
    // Dispatches the activity; its command now waits for an execution worker.
    await runWorkflowWorker(workers)
    await client.cancel(run.id)
    // The execution worker gets there before the cancellation's continuation.
    await runExecutionWorker(workers)

    expect(calls).toBe(0)
    await runWorkflowWorker(workers)
    await runExecutionWorker(workers)
    const snapshot = await client.get(run.id)
    expect(snapshot?.run.status).toBe('cancelled')
    expect(snapshot?.attempts.map((attempt) => attempt.status)).not.toContain(
      'completed',
    )
    expect(calls).toBe(0)
  })
})
