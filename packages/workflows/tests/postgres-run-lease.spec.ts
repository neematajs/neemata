import { randomUUID } from 'node:crypto'

import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it, vi } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

describe('postgres run leases', () => {
  it('keeps same-transaction lease reacquire semantics under PGlite', async () => {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const runtime = createPostgresWorkflowRuntime({ connection })
    const run = await runtime.store.createRun({
      workflowName: 'postgres-pglite-lease',
      input: {},
    })

    await connection.transaction(async (tx) => {
      const txRuntime = createPostgresWorkflowRuntime({ connection: tx })
      const expired = await txRuntime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 0,
      })
      const current = await txRuntime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 30_000,
      })
      const busy = await txRuntime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 30_000,
      })

      expect(expired).toBeDefined()
      expect(current).toBeDefined()
      expect(current?.leaseToken).not.toBe(expired?.leaseToken)
      expect(busy).toBeUndefined()
    })
  })
  it('acquires or rejects a lease in one statement', async () => {
    const database = new PGlite()
    const connection = createPostgresWorkflowConnection(database)
    try {
      await installPostgresWorkflowSchemaForTesting(connection)
      const runtime = createPostgresWorkflowRuntime({ connection })
      const run = await runtime.store.createRun({
        workflowName: 'grouped-lease',
        input: {},
      })
      const query = vi.spyOn(connection, 'query')
      const lease = await runtime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 30_000,
      })
      expect(lease).toMatchObject({ runId: run.id, version: run.version })
      expect(query).toHaveBeenCalledTimes(1)
      query.mockClear()
      expect(
        await runtime.store.acquireRunLease({ runId: run.id, leaseMs: 30_000 }),
      ).toBeUndefined()
      expect(query).toHaveBeenCalledTimes(1)
      query.mockClear()
      expect(
        await runtime.store.acquireRunLease({
          runId: randomUUID(),
          leaseMs: 30_000,
        }),
      ).toBeUndefined()
      expect(query).toHaveBeenCalledTimes(1)
    } finally {
      await database.close()
    }
  })
})
