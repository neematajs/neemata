import { randomUUID } from 'node:crypto'

import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { disposeRedisRuntimes, redisTargets } from './helpers.ts'

for (const target of redisTargets) {
  describe.skipIf(!target.url)(
    `Redis script cache flush recovery against ${target.name}`,
    () => {
      const clients: (Redis | Valkey)[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        vi.restoreAllMocks()
        await disposeRedisRuntimes(runtimes, clients)
      })

      function createHarness() {
        const client = target.createClient()
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix: `nmtjs:test:script-cache:${randomUUID()}:`,
        })
        clients.push(client)
        runtimes.push(runtime)
        // Counting the NOSCRIPT replies proves the cached SHAs really went
        // stale, so a pass cannot come from a flush that changed nothing.
        const evalsha = vi.spyOn(client, 'evalsha')
        const staleShaReplies = () =>
          evalsha.mock.settledResults.filter(
            (result) =>
              result.type === 'rejected' &&
              result.value instanceof Error &&
              result.value.message.includes('NOSCRIPT'),
          ).length
        return { client, runtime, staleShaReplies }
      }

      type Runtime = ReturnType<typeof createRedisWorkflowRuntime>

      async function settleRun(runtime: Runtime, workflowName: string) {
        const run = await runtime.store.createRun({ workflowName, input: {} })
        await runtime.store.markRunRunning({ runId: run.id })
        await runtime.store.completeRun({
          runId: run.id,
          output: { ok: true },
        })
        return run
      }

      async function deliverCommand(runtime: Runtime, workflowName: string) {
        const run = await runtime.store.createRun({ workflowName, input: {} })
        const command = {
          kind: 'continueRun' as const,
          runId: run.id,
          workflowName,
        }
        await runtime.runCoordinationExecutor.enqueue(command)
        const claimed = await runtime.runCoordinationExecutor.claim({
          workerId: 'worker',
          workflowNames: [workflowName],
          leaseMs: 30_000,
        })
        expect(claimed?.command).toStrictEqual(command)
        await runtime.runCoordinationExecutor.ack(claimed!)
      }

      it('reloads store scripts after the server script cache is flushed', async () => {
        const { client, runtime, staleShaReplies } = createHarness()
        await settleRun(runtime, 'before-flush')

        await client.script('FLUSH')

        const run = await settleRun(runtime, 'after-flush')
        await expect(
          runtime.store.loadRunSnapshot(run.id),
        ).resolves.toMatchObject({
          run: { status: 'completed', output: { ok: true } },
        })
        // createRun, markRunRunning and completeRun each held a stale SHA.
        expect(staleShaReplies()).toBeGreaterThanOrEqual(3)
      })

      it('recovers every concurrent caller of a flushed store script', async () => {
        const { client, runtime, staleShaReplies } = createHarness()
        await runtime.store.createRun({ workflowName: 'warm-up', input: {} })

        await client.script('FLUSH')

        const runs = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            runtime.store.createRun({
              workflowName: 'concurrent-after-flush',
              input: { index },
            }),
          ),
        )
        expect(new Set(runs.map((run) => run.id)).size).toBe(20)
        await expect(
          runtime.store.loadRuns(runs.map((run) => run.id)),
        ).resolves.toHaveLength(20)
        expect(staleShaReplies()).toBeGreaterThanOrEqual(1)
      })

      it('reloads queue scripts after the server script cache is flushed', async () => {
        const { client, runtime, staleShaReplies } = createHarness()
        await deliverCommand(runtime, 'queue-before-flush')

        await client.script('FLUSH')

        await deliverCommand(runtime, 'queue-after-flush')
        await expect(
          runtime.runCoordinationExecutor.claim({
            workerId: 'worker',
            workflowNames: ['queue-before-flush', 'queue-after-flush'],
            leaseMs: 30_000,
          }),
        ).resolves.toBeNull()
        // The store's createRun plus the queue's enqueue, claim and ack.
        expect(staleShaReplies()).toBeGreaterThanOrEqual(4)
      })
    },
  )
}
