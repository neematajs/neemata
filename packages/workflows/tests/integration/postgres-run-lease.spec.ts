import { performance } from 'node:perf_hooks'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../../src/adapters/postgres.ts'
import {
  createPostgresWorkflowHarness,
  postgresTarget,
  requireServiceEnv,
  type PostgresWorkflowHarness,
} from './helpers.ts'

requireServiceEnv(postgresTarget)

describe.skipIf(!postgresTarget.url)(
  '@nmtjs/workflows Postgres run lease integration',
  () => {
    const harnesses: PostgresWorkflowHarness[] = []

    afterEach(async () => {
      await Promise.allSettled(
        harnesses.splice(0).map((harness) => harness.cleanup()),
      )
    })

    async function createHarness() {
      const harness = await createPostgresWorkflowHarness(postgresTarget)
      harnesses.push(harness)
      return harness
    }

    it('returns busy promptly when another transaction holds the same run lease', async () => {
      const { runtime, pool } = await createHarness()
      const run = await runtime.store.createRun({
        workflowName: 'postgres-lease-contention',
        input: {},
      })
      const firstClient = await pool.connect()
      const secondClient = await pool.connect()
      let firstReleased = false
      let secondBegun = false
      const releaseFirst = async (statement: 'COMMIT' | 'ROLLBACK') => {
        if (firstReleased) return
        firstReleased = true
        await firstClient.query(statement)
      }

      try {
        await firstClient.query('BEGIN')
        const firstRuntime = createPostgresWorkflowRuntime({
          connection: createPostgresWorkflowConnection(firstClient),
        })
        const firstLease = await firstRuntime.store.acquireRunLease({
          runId: run.id,
          leaseMs: 30_000,
        })
        expect(firstLease).toBeDefined()

        const releaseTimer = setTimeout(() => {
          void releaseFirst('COMMIT').catch(() => {})
        }, 2_000)
        try {
          await secondClient.query('BEGIN')
          secondBegun = true
          const secondRuntime = createPostgresWorkflowRuntime({
            connection: createPostgresWorkflowConnection(secondClient),
          })
          const startedAt = performance.now()
          const secondLease = await secondRuntime.store.acquireRunLease({
            runId: run.id,
            leaseMs: 30_000,
          })
          const elapsedMs = performance.now() - startedAt

          expect(secondLease).toBeUndefined()
          expect(elapsedMs).toBeLessThan(500)
        } finally {
          clearTimeout(releaseTimer)
        }
      } finally {
        await releaseFirst('ROLLBACK').catch(() => {})
        if (secondBegun) {
          await secondClient.query('ROLLBACK').catch(() => {})
        }
        firstClient.release()
        secondClient.release()
      }
    }, 10_000)
  },
)
