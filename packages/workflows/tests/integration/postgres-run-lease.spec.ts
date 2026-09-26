import { performance } from 'node:perf_hooks'

import { afterEach, describe, expect, it } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../../src/adapters/postgres.ts'
import { StaleWriteFenceError } from '../../src/runtime/index.ts'
import {
  createPostgresWorkflowHarness,
  postgresTarget,
  requireServiceEnv,
  wait,
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

    // Runs `write` in a transaction left open until the returned `commit`.
    function openWriter(pool: PostgresWorkflowHarness['pool']) {
      let commit!: () => void
      const committing = new Promise<void>((resolve) => {
        commit = resolve
      })
      let ready!: (
        runtime: ReturnType<typeof createPostgresWorkflowRuntime>,
      ) => void
      const opened = new Promise<
        ReturnType<typeof createPostgresWorkflowRuntime>
      >((resolve) => {
        ready = resolve
      })
      const committed = createPostgresWorkflowConnection(pool).transaction(
        async (tx) => {
          ready(createPostgresWorkflowRuntime({ connection: tx }))
          await committing
        },
      )
      return { opened, commit, committed }
    }

    async function failedAttempt(runtime: PostgresWorkflowHarness['runtime']) {
      const run = await runtime.store.createRun({
        workflowName: 'postgres-attempt-fence',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'step',
        kind: 'activity',
      })
      const step = { runId: run.id, nodeName: 'step', childKey: '$self' }
      await runtime.store.ensureNodeChildren({
        runId: run.id,
        nodeName: 'step',
        children: [{ childKey: '$self', kind: 'activity' }],
      })
      const { attempt } = await runtime.store.ensureChildAttempt({
        ...step,
        input: {},
      })
      await runtime.store.failCurrentAttempt({
        attemptId: attempt.id,
        leaseToken: attempt.leaseToken!,
        error: new Error('retrying'),
      })
      return {
        step,
        attempt,
        retry: () =>
          ({ ...step, input: attempt.input, after: attempt.id }) as const,
        fence: { attempt: { ...step, attemptId: attempt.id } },
      }
    }

    it('makes a retry replacing the attempt wait for a write fenced by it', async () => {
      const { runtime, pool } = await createHarness()
      const { step, attempt, retry, fence } = await failedAttempt(runtime)
      const writer = openWriter(pool)
      try {
        const writerRuntime = await writer.opened
        // A retry does not touch the run row: only the fence locks the child.
        await writerRuntime.store.markRunRunning({ runId: step.runId, fence })

        let replaced = false
        const replacement = runtime.store
          .createAttempt(retry())
          .then((successor) => {
            replaced = true
            return successor
          })
        await wait(300)
        expect(replaced).toBe(false)

        writer.commit()
        await writer.committed
        expect((await replacement).id).not.toBe(attempt.id)
      } finally {
        writer.commit()
        await writer.committed.catch(() => {})
      }
    }, 10_000)

    it('refuses a write fenced by an attempt a retry replaced while it waited', async () => {
      const { runtime, pool } = await createHarness()
      const { step, retry, fence } = await failedAttempt(runtime)
      const replacer = openWriter(pool)
      try {
        await (await replacer.opened).store.createAttempt(retry())

        let settled = false
        const write = runtime.store
          .failNode({
            runId: step.runId,
            nodeName: step.nodeName,
            error: new Error('fenced'),
            fence,
          })
          .finally(() => {
            settled = true
          })
        write.catch(() => {})
        await wait(300)
        expect(settled).toBe(false)

        replacer.commit()
        await replacer.committed
        await expect(write).rejects.toBeInstanceOf(StaleWriteFenceError)
        const snapshot = await runtime.store.loadRunSnapshot(step.runId)
        expect(snapshot?.nodes[0]?.status).not.toBe('failed')
      } finally {
        replacer.commit()
        await replacer.committed.catch(() => {})
      }
    }, 10_000)

    it('makes a takeover wait for a fenced write holding the lease, so the new holder sees it', async () => {
      const { runtime, pool } = await createHarness()
      const run = await runtime.store.createRun({
        workflowName: 'postgres-lease-fenced-write',
        input: {},
      })
      const stale = await runtime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 200,
      })
      const writer = openWriter(pool)
      try {
        const writerRuntime = await writer.opened
        await writerRuntime.store.markRunRunning({
          runId: run.id,
          fence: { runLease: stale! },
        })
        await wait(300)

        let takenOver = false
        const takeover = runtime.store
          .acquireRunLease({ runId: run.id, leaseMs: 30_000 })
          .then((lease) => {
            takenOver = true
            return lease
          })
        await wait(300)
        expect(takenOver).toBe(false)

        writer.commit()
        await writer.committed
        const lease = await takeover
        expect(lease?.leaseToken).not.toBe(stale!.leaseToken)
        const [observed] = await runtime.store.loadRuns([run.id])
        expect(observed?.status).toBe('running')
      } finally {
        writer.commit()
        await writer.committed.catch(() => {})
      }
    }, 10_000)

    it('reports a retry busy instead of waiting on a lease a fenced write holds', async () => {
      const { runtime, pool } = await createHarness()
      const run = await runtime.store.createRun({
        workflowName: 'postgres-lease-fenced-retry',
        input: {},
      })
      await runtime.store.createNode({
        runId: run.id,
        name: 'step',
        kind: 'activity',
      })
      await runtime.store.failRun({ runId: run.id, error: new Error('boom') })
      const [failed] = await runtime.store.loadRuns([run.id])
      const lease = await runtime.store.acquireRunLease({
        runId: run.id,
        leaseMs: 200,
      })
      const fence = { runLease: lease! }
      const writer = openWriter(pool)
      try {
        const writerRuntime = await writer.opened
        // Leaves the run row unlocked, so the retry locks it first and then
        // meets the lease row this transaction holds.
        await writerRuntime.store.setNodeInput({
          runId: run.id,
          nodeName: 'step',
          input: 1,
          fence,
        })
        await wait(300)

        const retry = { runId: run.id, expectedVersion: failed!.version }
        const startedAt = performance.now()
        await expect(runtime.store.reopenFailedRun(retry)).rejects.toThrow(
          `Run [${run.id}] is busy`,
        )
        expect(performance.now() - startedAt).toBeLessThan(500)

        writer.commit()
        await writer.committed
        await expect(
          runtime.store.reopenFailedRun(retry),
        ).resolves.toMatchObject({ id: run.id, status: 'queued' })
      } finally {
        writer.commit()
        await writer.committed.catch(() => {})
      }
    }, 10_000)
  },
)
