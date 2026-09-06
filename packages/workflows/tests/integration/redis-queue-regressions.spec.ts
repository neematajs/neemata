import { randomUUID } from 'node:crypto'

import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowRedisClient } from '../../src/adapters/redis.ts'
import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { RedisWorkflowKeys } from '../../src/adapters/redis/keys.ts'
import { RedisWorkflowQueue } from '../../src/adapters/redis/queue.ts'
import { defineWorkflow, implementWorkflow } from '../../src/index.ts'
import { runWorkflowWorker } from '../../src/runtime/index.ts'
import { createTestContainer, wait } from './helpers.ts'

type Target = {
  readonly name: string
  readonly url: string | undefined
  createClient(): WorkflowRedisClient
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
    `Redis queue regressions against ${target.name}`,
    () => {
      const clients: WorkflowRedisClient[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        vi.restoreAllMocks()
        await Promise.allSettled(
          runtimes.splice(0).map(async (runtime) => await runtime.dispose?.()),
        )
        await Promise.allSettled(
          clients.splice(0).map(async (client) => await client.quit()),
        )
      })

      function createHarness(options?: {
        readonly maxDeliveries?: number
        readonly terminalRetentionMs?: number
      }) {
        const client = target.createClient()
        const keyPrefix = `nmtjs:test:queue-regressions:${randomUUID()}:`
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          maxDeliveries: options?.maxDeliveries ?? 3,
          terminalRetentionMs: options?.terminalRetentionMs ?? 5_000,
        })
        clients.push(client)
        runtimes.push(runtime)
        return {
          client,
          keyPrefix,
          keys: new RedisWorkflowKeys(keyPrefix),
          runtime,
        }
      }

      it('coalesces an expired continue lease into the latest pending payload', async () => {
        const { runtime } = createHarness()
        const run = await runtime.store.createRun({
          workflowName: 'coalesced',
          input: null,
        })
        const first = {
          kind: 'continueRun' as const,
          runId: run.id,
          workflowName: run.workflowName,
          generation: 1,
        }
        const latest = { ...first, generation: 2 }
        const worker = {
          workerId: 'coalesced',
          workflowNames: [run.workflowName],
          leaseMs: 50,
        }
        await runtime.runCoordinationExecutor.enqueue(first)
        const expired = await runtime.runCoordinationExecutor.claim(worker)
        expect(expired).not.toBeNull()
        await runtime.runCoordinationExecutor.enqueue(latest)
        await wait(80)
        const claim = await runtime.runCoordinationExecutor.claim(worker)
        expect(claim?.command).toStrictEqual(latest)
        await runtime.runCoordinationExecutor.ack(claim!)
        await expect(
          runtime.runCoordinationExecutor.ack(expired!),
        ).rejects.toThrow('Stale')
        await expect(
          runtime.runCoordinationExecutor.claim(worker),
        ).resolves.toBeNull()
      })

      it('drains routed work beyond the first sorted-set scan page', async () => {
        const { client, keys, runtime } = createHarness()
        const workflow = defineWorkflow({
          name: `scan-target-${randomUUID()}`,
          input: t.object({ value: t.string() }),
          output: t.object({ value: t.string() }),
        }).build()
        const implementation = implementWorkflow(workflow).finish(
          (_context, _outputs, input) => input,
        )
        const run = await runtime.store.createRun({
          workflowName: workflow.name,
          input: { value: 'target' },
        })
        await Promise.all(
          Array.from({ length: 600 }, async () => {
            await runtime.runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId: randomUUID(),
              workflowName: 'unrelated',
            })
          }),
        )
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: run.id,
          workflowName: workflow.name,
        })

        const queue = keys.queue('continue')
        const targetId = await client.hget(queue.dedup, run.id)
        expect(targetId).toBeTypeOf('string')
        const [, firstPage] = await client.zscan(queue.ready, '0', 'COUNT', 128)
        const firstIds = new Set(
          firstPage.filter((_entry, index) => index % 2 === 0),
        )
        if (firstIds.has(targetId!)) {
          const allIds = await client.zrange(queue.ready, '0', '-1')
          const outsideId = allIds.find((id) => !firstIds.has(id))
          expect(outsideId).toBeTypeOf('string')
          const [targetRaw, outsideRaw] = await Promise.all([
            client.hget(queue.items, targetId!),
            client.hget(queue.items, outsideId!),
          ])
          const targetItem = JSON.parse(targetRaw!) as QueueRecord
          const outsideItem = JSON.parse(outsideRaw!) as QueueRecord
          const outsideRunId = outsideItem.payload.runId
          const targetPayload = targetItem.payload
          targetItem.payload = outsideItem.payload
          outsideItem.payload = targetPayload
          await client.hset(queue.items, targetId!, JSON.stringify(targetItem))
          await client.hset(
            queue.items,
            outsideId!,
            JSON.stringify(outsideItem),
          )
          await client.hset(queue.dedup, run.id, outsideId!)
          await client.hset(queue.dedup, outsideRunId, targetId!)
        }

        await runWorkflowWorker({
          ...runtime,
          container: createTestContainer(),
          workflows: [implementation],
          workerId: 'full-scan-worker',
        })

        const snapshot = await runtime.store.loadRunSnapshot(run.id)
        expect(snapshot?.run.status).toBe('completed')
        expect(snapshot?.run.output).toStrictEqual({ value: 'target' })
      })

      it('reclaims expired routes without sequential client-side item reads', async () => {
        const { client, keys, runtime } = createHarness()
        await Promise.all(
          Array.from({ length: 300 }, async () => {
            await runtime.runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId: randomUUID(),
              workflowName: 'offline-route',
            })
          }),
        )
        const worker = {
          workerId: 'offline-worker',
          workflowNames: ['offline-route'],
          leaseMs: 60_000,
        }
        let claimed = 0
        for (let index = 0; index < 300; index += 1) {
          if (await runtime.runCoordinationExecutor.claim(worker)) claimed += 1
        }
        expect(claimed).toBe(300)

        const claimedKey = keys.queue('continue').claimed
        const ids = await client.zrange(claimedKey, '0', '-1')
        await Promise.all(
          ids.map(async (id) => await client.zadd(claimedKey, 0, id)),
        )

        const mutableClient = client as unknown as { hget: HgetCommand }
        const hget = mutableClient.hget.bind(client)
        let hgetCalls = 0
        mutableClient.hget = async (...arguments_) => {
          hgetCalls += 1
          return await hget(...arguments_)
        }

        await expect(
          runtime.runCoordinationExecutor.claim({
            workerId: 'other-worker',
            workflowNames: ['other-route'],
            leaseMs: 1_000,
          }),
        ).resolves.toBeNull()
        expect(hgetCalls).toBe(0)
        expect(await client.zcard(claimedKey)).toBe(300)
      })

      it('uses the Redis clock for leases and preserves opaque payloads through renewal', async () => {
        const { client, keys, runtime } = createHarness()
        const command = {
          kind: 'activityAttempt' as const,
          workflowName: 'clock-workflow',
          activityName: 'content',
          runId: randomUUID(),
          nodeName: 'content',
          childKey: '$self',
          attemptId: randomUUID(),
          leaseToken: randomUUID(),
          input: {
            exact: Number.MAX_SAFE_INTEGER,
            values: [
              Number.MAX_SAFE_INTEGER,
              { exact: Number.MAX_SAFE_INTEGER },
            ],
          },
          idempotencyKey: ['request', Number.MAX_SAFE_INTEGER] as const,
        }
        await runtime.attemptExecutor.dispatchActivity(command)
        const readyKey = keys.queue('attempt').ready
        const [id] = await client.zrange(readyKey, '0', '-1')
        await client.zadd(readyKey, 0, id!)

        const localNow = Date.now()
        vi.spyOn(Date, 'now').mockReturnValue(localNow - 60_000)
        const claim = await runtime.attemptExecutor.claim({
          workerId: 'skewed-worker',
          workflowNames: ['clock-workflow'],
          activityNames: ['content'],
          taskNames: [],
          leaseMs: 30_000,
        })
        vi.restoreAllMocks()

        expect(claim?.command).toStrictEqual(command)
        await expect(
          runtime.attemptExecutor.claim({
            workerId: 'normal-worker',
            workflowNames: ['clock-workflow'],
            activityNames: ['content'],
            taskNames: [],
            leaseMs: 30_000,
          }),
        ).resolves.toBeNull()
        await expect(
          runtime.attemptExecutor.heartbeat(claim!, 30_000),
        ).resolves.toStrictEqual({
          runStatus: 'queued',
        })
        await runtime.attemptExecutor.release(claim!)
        await wait(70)
        const redelivered = await runtime.attemptExecutor.claim({
          workerId: 'normal-worker',
          workflowNames: ['clock-workflow'],
          activityNames: ['content'],
          taskNames: [],
          leaseMs: 30_000,
        })
        expect(redelivered?.command).toStrictEqual(command)
        await runtime.attemptExecutor.ack(redelivered!)
      })

      it('removes ready, claimed, and dead commands after their run family expires', async () => {
        const { client, keys, runtime } = createHarness({
          maxDeliveries: 1,
          terminalRetentionMs: 80,
        })
        const run = await runtime.store.createRun({
          workflowName: 'retained-family',
          input: null,
        })
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: run.id,
          workflowName: run.workflowName,
        })
        const claimed = await runtime.runCoordinationExecutor.claim({
          workerId: 'claimed-worker',
          workflowNames: [run.workflowName],
          leaseMs: 60_000,
        })
        expect(claimed).not.toBeNull()

        const deadAttempt = activityCommand(run.id, run.workflowName, 'dead')
        await runtime.attemptExecutor.dispatchActivity(deadAttempt)
        const deadClaim = await runtime.attemptExecutor.claim({
          workerId: 'dead-worker',
          workflowNames: [run.workflowName],
          activityNames: ['dead'],
          taskNames: [],
          leaseMs: 60_000,
        })
        await runtime.attemptExecutor.release(deadClaim!, {
          error: new Error('dead delivery'),
        })

        const readyAttempt = activityCommand(run.id, run.workflowName, 'ready')
        await runtime.attemptExecutor.dispatchActivity(readyAttempt)
        await runtime.store.completeRun({ runId: run.id, output: null })
        await waitUntil(
          async () => (await client.exists(keys.family(run.id))) === 0,
        )

        await expect(runtime.store.listDeadCommands()).resolves.toStrictEqual(
          [],
        )
        await expect(
          runtime.runCoordinationExecutor.claim({
            workerId: 'orphan-cleaner',
            workflowNames: ['unrelated'],
            leaseMs: 1_000,
          }),
        ).resolves.toBeNull()
        await expect(
          runtime.attemptExecutor.claim({
            workerId: 'attempt-orphan-cleaner',
            workflowNames: ['unrelated'],
            taskNames: ['unrelated'],
            leaseMs: 1_000,
          }),
        ).resolves.toBeNull()

        for (const kind of ['continue', 'attempt'] as const) {
          const queue = keys.queue(kind)
          expect(await client.hlen(queue.items)).toBe(0)
          expect(await client.zcard(queue.ready)).toBe(0)
          expect(await client.zcard(queue.claimed)).toBe(0)
          expect(await client.zcard(queue.dead)).toBe(0)
          expect(await client.hlen(queue.dedup)).toBe(0)
        }
      })

      it('bounds a late start marker by the terminal family retention window', async () => {
        const { client, keys, runtime } = createHarness({
          terminalRetentionMs: 300,
        })
        const runInput = {
          workflowName: 'terminal-repair',
          input: null,
          idempotencyKey: ['terminal-repair', randomUUID()],
        } as const
        const run = await runtime.store.createRun(runInput)
        await runtime.store.completeRun({ runId: run.id, output: null })
        await wait(40)

        const queue = new RedisWorkflowQueue({
          client,
          keys,
          kind: 'continue',
          maxDeliveries: 3,
          wakeKind: () => 'continue',
          dedupKey: (command) => command.runId,
          deadKind: () => 'continue',
        })
        const command = {
          kind: 'continueRun' as const,
          runId: run.id,
          workflowName: run.workflowName,
        }
        const markerKey = keys.startDispatch(run.id)
        await queue.enqueueWithMarker(command, markerKey)

        const familyTtl = await client.pttl(keys.family(run.id))
        const markerTtl = await client.pttl(markerKey)
        expect(familyTtl).toBeGreaterThan(0)
        expect(markerTtl).toBeGreaterThan(0)
        expect(markerTtl).toBeLessThanOrEqual(familyTtl + 10)

        await waitUntil(
          async () => (await client.exists(keys.family(run.id))) === 0,
        )
        await queue.enqueueWithMarker(command, markerKey)
        expect(await client.exists(markerKey)).toBe(0)
      })
    },
  )
}

type QueueRecord = {
  payload: {
    runId: string
    workflowName: string
  }
}

type HgetCommand = (...arguments_: readonly unknown[]) => Promise<string | null>

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

async function waitUntil(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!(await condition())) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for Redis state')
    await wait(20)
  }
}
