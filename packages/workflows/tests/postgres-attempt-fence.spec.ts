import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'

import type { WorkflowPostgresConnection } from '../src/adapters/postgres.ts'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

/**
 * Runs `interfere` once, right after the first child pre-read, so the
 * settle path sees a fresh fence and writes against a superseded one.
 */
function raceOnChildRead(
  connection: WorkflowPostgresConnection,
  interfere: () => Promise<void>,
): WorkflowPostgresConnection {
  let pending: (() => Promise<void>) | undefined = interfere
  return {
    async query(sql, params) {
      const result = await connection.query(sql, params)
      if (pending && sql.includes('FROM workflow_node_children')) {
        const run = pending
        pending = undefined
        await run()
      }
      return result
    },
    transaction: (handler) => connection.transaction(handler),
  }
}

describe('postgres attempt fencing', () => {
  it('refuses to time out an attempt superseded after the pre-read', async () => {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    const { store } = runtime

    const run = await store.createRun({
      workflowName: 'attempt-fence',
      input: {},
    })
    await store.createNode({ runId: run.id, name: 'step', kind: 'activity' })
    await store.ensureNodeChildren({
      runId: run.id,
      nodeName: 'step',
      children: [{ childKey: '$self', kind: 'activity' }],
    })
    const stale = await store.createAttempt({
      runId: run.id,
      nodeName: 'step',
      childKey: '$self',
      input: {},
    })

    const raced = createPostgresWorkflowRuntime({
      connection: raceOnChildRead(connection, async () => {
        await store.createAttempt({
          runId: run.id,
          nodeName: 'step',
          childKey: '$self',
          input: {},
        })
      }),
    })
    const timedOut = await raced.store.timeoutCurrentAttempt({
      attemptId: stale.id,
      leaseToken: stale.leaseToken!,
      error: new Error('timeout'),
    })

    expect(timedOut).toBeUndefined()
    const { attempts } = await store.loadNodeChildren({
      runId: run.id,
      nodeName: 'step',
    })
    const settled = attempts.find((attempt) => attempt.id === stale.id)
    expect(settled?.status).toBe('started')
  })
})
