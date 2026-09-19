import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

describe('postgres max deliveries', () => {
  it('applies the configured threshold inside an atomic scope', async () => {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({
      connection,
      maxDeliveries: 1,
    })
    const workflowName = 'atomic-max-deliveries'
    const run = await runtime.store.createRun({ workflowName, input: {} })

    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName,
    })
    const claimed = await runtime.runCoordinationExecutor.claim({
      workerId: 'worker',
      workflowNames: [workflowName],
      leaseMs: 30_000,
    })
    expect(claimed).not.toBeNull()

    await runtime.atomicCompletion.run(async (scoped) => {
      await scoped.runCoordinationExecutor.release(claimed!, {
        error: new Error('boom'),
      })
    })

    const dead = await runtime.store.listDeadCommands({ runId: run.id })
    expect(dead).toHaveLength(1)
  })
})
