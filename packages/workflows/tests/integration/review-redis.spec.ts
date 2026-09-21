import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { Keys } from '../../src/adapters/redis/keys.ts'
import { matchingKeys } from './helpers.ts'

type Target = {
  readonly name: string
  readonly url: string | undefined
  createClient(): Redis | Valkey
}

const targets: readonly Target[] = [
  {
    name: 'Redis',
    url: process.env.REDIS_URL,
    createClient: () => new Redis(process.env.REDIS_URL!),
  },
  {
    name: 'Valkey',
    url: process.env.VALKEY_URL,
    createClient: () => new Valkey(process.env.VALKEY_URL!),
  },
]

for (const target of targets) {
  describe.skipIf(!target.url)(
    `Redis review regressions against ${target.name}`,
    () => {
      const clients: (Redis | Valkey)[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        await Promise.allSettled(
          runtimes.splice(0).map(async (runtime, index) => {
            await runtime.dispose?.()
            const client = clients[index]!
            const keys = await matchingKeys(client, `${runtime.keyPrefix}*`)
            for (let offset = 0; offset < keys.length; offset += 100) {
              await client.del(...keys.slice(offset, offset + 100))
            }
          }),
        )
        await Promise.allSettled(
          clients.splice(0).map(async (client) => await client.quit()),
        )
      })

      function createHarness(maxDeliveries?: number) {
        const client = target.createClient()
        const keyPrefix = `nmtjs:test:review-redis:${randomUUID()}:`
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          ...(maxDeliveries === undefined ? {} : { maxDeliveries }),
        })
        clients.push(client)
        runtimes.push(runtime)
        return { client, keyPrefix, keys: new Keys(keyPrefix), runtime }
      }

      it('maintenance collects commands enqueued after their family was deleted', async () => {
        const { client, keyPrefix, keys, runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'late-enqueue',
          input: null,
        })
        await runtime.store.completeRun({ runId: run.id, output: null })
        await expect(runtime.store.deleteRun(run.id)).resolves.toEqual({
          deleted: true,
        })

        // A paused worker resumes after the deletion and still enqueues.
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: run.id,
          workflowName: run.workflowName,
        })
        await runtime.runCoordinationExecutor.enqueueDelayed(
          {
            kind: 'continueRun',
            runId: randomUUID(),
            workflowName: run.workflowName,
          },
          Date.now() + 60_000,
        )
        await runtime.attemptExecutor.dispatchActivity(
          activityCommand(run.id, run.workflowName, 'ready'),
        )
        await runtime.attemptExecutor.dispatchActivity(
          activityCommand(run.id, run.workflowName, 'claimed'),
        )
        // The claiming worker then disappears, leaving the route unserved.
        const claim = await runtime.attemptExecutor.claim({
          workerId: 'vanishing',
          workflowNames: [run.workflowName],
          activityNames: ['claimed'],
          taskNames: [],
          leaseMs: 60_000,
        })
        expect(claim).not.toBeNull()
        expect(await client.hlen(keys.queue('continue').items)).toBe(2)
        expect(await client.hlen(keys.queue('attempt').items)).toBe(2)

        await runtime.store.pruneTerminalRuns({ olderThan: 0 })

        for (const kind of ['continue', 'attempt'] as const) {
          const queue = keys.queue(kind)
          expect(await client.hlen(queue.items)).toBe(0)
          expect(await client.hlen(queue.dedup)).toBe(0)
        }
        expect(await matchingKeys(client, `${keyPrefix}queue:*`)).toEqual([])
      })

      it('maintenance keeps the commands of mapped runs and unmapped dead letters', async () => {
        const { runtime } = createHarness(1)
        const run = await runtime.store.createRun({
          workflowName: 'live-family',
          input: null,
        })
        const live = {
          kind: 'continueRun' as const,
          runId: run.id,
          workflowName: run.workflowName,
        }
        await runtime.runCoordinationExecutor.enqueue(live)
        const attempt = activityCommand(run.id, run.workflowName, 'live')
        await runtime.attemptExecutor.dispatchActivity(attempt)

        // Dead letters answer to the dead-letter cutoff, mapped or not.
        const dead = activityCommand(randomUUID(), 'dead-family', 'dead')
        await runtime.attemptExecutor.dispatchActivity(dead)
        const deadClaim = await runtime.attemptExecutor.claim({
          workerId: 'dead-worker',
          workflowNames: ['dead-family'],
          taskNames: [],
          leaseMs: 60_000,
        })
        await runtime.attemptExecutor.release(deadClaim!, {
          error: new Error('dead delivery'),
        })
        await expect(runtime.store.listDeadCommands()).resolves.toHaveLength(1)

        await runtime.store.pruneTerminalRuns({ olderThan: 0 })

        await expect(runtime.store.listDeadCommands()).resolves.toHaveLength(1)
        const continued = await runtime.runCoordinationExecutor.claim({
          workerId: 'live-worker',
          workflowNames: [run.workflowName],
          leaseMs: 60_000,
        })
        expect(continued?.command).toStrictEqual(live)
        const executed = await runtime.attemptExecutor.claim({
          workerId: 'live-worker',
          workflowNames: [run.workflowName],
          taskNames: [],
          leaseMs: 60_000,
        })
        expect(executed?.command).toStrictEqual(attempt)
      })
    },
  )
}

function activityCommand(
  runId: string,
  workflowName: string,
  activityName: string,
) {
  return {
    kind: 'activityAttempt' as const,
    workflowName,
    activityName,
    runId,
    nodeName: activityName,
    childKey: '$self',
    attemptId: randomUUID(),
    leaseToken: randomUUID(),
    input: null,
  }
}
