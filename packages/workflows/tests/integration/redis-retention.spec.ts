import { randomUUID } from 'node:crypto'

import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { Keys } from '../../src/adapters/redis/keys.ts'
import {
  activityCommand,
  disposeRedisRuntimes,
  matchingKeys,
  redisTargets,
  wait,
} from './helpers.ts'

// Larger than the base cleanup batch of 1,000 ids, which is what let a family
// leave more expired ids behind than the next transition removed.
const FAMILY_CHILDREN = 1200
const FAMILY_SIZE = FAMILY_CHILDREN + 1

for (const target of redisTargets) {
  describe.skipIf(!target.url)(
    `Redis terminal retention against ${target.name}`,
    () => {
      const clients: (Redis | Valkey)[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        await disposeRedisRuntimes(runtimes, clients)
      })

      function createHarness(options?: {
        readonly maxDeliveries?: number
        readonly terminalRetentionMs?: number
      }) {
        const client = target.createClient()
        const keyPrefix = `nmtjs:test:retention:${randomUUID()}:`
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          ...options,
        })
        clients.push(client)
        runtimes.push(runtime)
        return {
          client,
          keyPrefix,
          keys: new Keys(keyPrefix),
          runtime,
          ordered: `${keyPrefix}runs:ordered`,
          terminal: `${keyPrefix}runs:terminal`,
        }
      }

      type Store = ReturnType<typeof createRedisWorkflowRuntime>['store']

      describe('queue maintenance when terminal families are pruned', () => {
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
          const { runtime } = createHarness({ maxDeliveries: 1 })
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
          await expect(runtime.store.listDeadCommands()).resolves.toHaveLength(
            1,
          )

          await runtime.store.pruneTerminalRuns({ olderThan: 0 })

          await expect(runtime.store.listDeadCommands()).resolves.toHaveLength(
            1,
          )
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
      })

      describe('expired chronological index cleanup on terminal transitions', () => {
        async function completeFamily(store: Store) {
          const run = await store.createRun({
            workflowName: 'short',
            input: null,
          })
          await store.completeRun({ runId: run.id, output: null })
          return run
        }

        it('drops expired run ids from the chronological index while a run stays active', async () => {
          const { client, runtime, ordered, terminal } = createHarness({
            terminalRetentionMs: 100,
          })
          const active = await runtime.store.createRun({
            workflowName: 'long',
            input: null,
          })
          for (let index = 0; index < 20; index += 1) {
            await completeFamily(runtime.store)
          }
          expect(await client.zcard(ordered)).toBe(21)
          await wait(160)
          // No listing or pruning runs here: the next terminal transition alone
          // has to bring the index back to the retention window.
          const latest = await completeFamily(runtime.store)
          expect(
            await client.zrange(ordered, '-inf', '+inf', 'BYSCORE'),
          ).toEqual([active.id, latest.id])
          expect(
            await client.zrange(terminal, '-inf', '+inf', 'BYSCORE'),
          ).toEqual([latest.id])
        })

        it('keeps expiry entries until their ids left the chronological index', async () => {
          const { client, runtime, ordered, terminal } = createHarness({
            terminalRetentionMs: 100,
          })
          // Completing with nothing active arms a TTL on both indexes; new work
          // then has to disarm the terminal one along with the ordered one.
          await completeFamily(runtime.store)
          expect(await client.pttl(terminal)).toBeGreaterThan(0)
          const active = await runtime.store.createRun({
            workflowName: 'long',
            input: null,
          })
          expect(await client.pttl(ordered)).toBe(-1)
          expect(await client.pttl(terminal)).toBe(-1)
          await completeFamily(runtime.store)
          expect(await client.pttl(terminal)).toBe(-1)
          await wait(160)
          expect(await client.zcard(terminal)).toBe(2)
          const latest = await completeFamily(runtime.store)
          expect(
            await client.zrange(ordered, '-inf', '+inf', 'BYSCORE'),
          ).toEqual([active.id, latest.id])
          await runtime.store.completeRun({ runId: active.id, output: null })
          expect(await client.pttl(ordered)).toBeGreaterThan(0)
          expect(await client.pttl(terminal)).toBeGreaterThan(0)
          await wait(160)
          expect(await client.exists(ordered, terminal)).toBe(0)
        })

        it('bounds the expired ids one terminal transition removes', async () => {
          const { client, runtime, ordered, terminal } = createHarness({
            terminalRetentionMs: 60_000,
          })
          const active = await runtime.store.createRun({
            workflowName: 'long',
            input: null,
          })
          const seed = client.pipeline()
          for (let index = 0; index < 1500; index += 1) {
            const id = `expired-${index}`
            seed.zadd(terminal, 1, id).zadd(ordered, -1500 + index, id)
          }
          await seed.exec()
          const first = await completeFamily(runtime.store)
          // The batch is 1,000 ids plus two for every run the transition indexes.
          expect(await client.zcard(ordered)).toBe(500)
          expect(await client.zcard(terminal)).toBe(499)
          const second = await completeFamily(runtime.store)
          expect(
            await client.zrange(ordered, '-inf', '+inf', 'BYSCORE'),
          ).toEqual([active.id, first.id, second.id])
          expect(
            (await client.zrange(terminal, '-inf', '+inf', 'BYSCORE')).sort(),
          ).toEqual([first.id, second.id].sort())
        })
      })

      describe('expired index cleanup for families larger than the base batch', () => {
        async function completeFamily(store: Store, children: number) {
          const root = await store.createRun({
            workflowName: 'mapping',
            input: null,
          })
          if (children > 0) {
            const childKeys = Array.from({ length: children }, (_, index) =>
              String(index),
            )
            await store.createNode({
              runId: root.id,
              name: 'items',
              kind: 'workflow',
            })
            await store.ensureNodeChildren({
              runId: root.id,
              nodeName: 'items',
              children: childKeys.map((childKey) => ({
                childKey,
                kind: 'workflow' as const,
              })),
            })
            for (let offset = 0; offset < children; offset += 200) {
              await Promise.all(
                childKeys.slice(offset, offset + 200).map(async (childKey) => {
                  const { childRun } = await store.ensureChildRun({
                    runId: root.id,
                    nodeName: 'items',
                    childKey,
                    childKind: 'workflow',
                    childName: 'item',
                    input: null,
                    rootRunId: root.id,
                  })
                  await store.completeRun({ runId: childRun.id, output: null })
                }),
              )
            }
          }
          await store.completeRun({ runId: root.id, output: null })
          return root
        }

        it('keeps expired-index cleanup in pace with families larger than the base batch', async () => {
          const { client, runtime, ordered, terminal } = createHarness({
            terminalRetentionMs: 100,
          })
          const active = await runtime.store.createRun({
            workflowName: 'long',
            input: null,
          })
          // No listing or pruning runs here: the terminal transitions alone
          // have to keep both indexes within the retention window.
          for (let round = 0; round < 3; round += 1) {
            await completeFamily(runtime.store, FAMILY_CHILDREN)
            expect(await client.zcard(ordered)).toBe(1 + FAMILY_SIZE)
            expect(await client.zcard(terminal)).toBe(FAMILY_SIZE)
            await wait(160)
          }
          // A small family removes less than the large one left behind, but the
          // backlog still drains instead of accumulating.
          const first = await completeFamily(runtime.store, 0)
          expect(await client.zcard(ordered)).toBeLessThan(FAMILY_SIZE)
          const second = await completeFamily(runtime.store, 0)
          expect(
            await client.zrange(ordered, '-inf', '+inf', 'BYSCORE'),
          ).toEqual([active.id, first.id, second.id])
          expect(
            (await client.zrange(terminal, '-inf', '+inf', 'BYSCORE')).sort(),
          ).toEqual([first.id, second.id].sort())
        }, 60_000)

        it('removes more expired ids than one ZREM call can take', async () => {
          const { client, runtime, ordered, terminal } = createHarness({
            terminalRetentionMs: 60_000,
          })
          const active = await runtime.store.createRun({
            workflowName: 'long',
            input: null,
          })
          const root = await runtime.store.createRun({
            workflowName: 'mapping',
            input: null,
          })
          // Building thousands of real children is slow, and the cleanup batch
          // only depends on how many ids the family lists.
          const members = Array.from(
            { length: 4000 },
            (_, index) => `member-${index}`,
          )
          await client.hset(
            `${runtime.keyPrefix}family:${root.id}`,
            'runIds',
            JSON.stringify([root.id, ...members]),
          )
          // Lua cannot unpack 8,000 values into one command, which the scaled
          // batch exceeds here.
          const backlog = 1000 + 2 * (members.length + 1)
          for (let offset = 0; offset < backlog; offset += 1000) {
            const seed = client.pipeline()
            const limit = Math.min(offset + 1000, backlog)
            for (let index = offset; index < limit; index += 1) {
              const id = `expired-${index}`
              seed.zadd(terminal, 1, id).zadd(ordered, -backlog + index, id)
            }
            await seed.exec()
          }
          await runtime.store.completeRun({ runId: root.id, output: null })
          expect(await client.zcard(ordered)).toBe(2)
          expect(await client.zscore(ordered, active.id)).not.toBeNull()
          expect(await client.zcard(terminal)).toBe(members.length + 1)
        })
      })
    },
  )
}
