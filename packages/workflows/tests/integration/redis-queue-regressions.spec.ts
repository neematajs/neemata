import { randomUUID } from 'node:crypto'

import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { RedisWorkflowKeys } from '../../src/adapters/redis/keys.ts'
import { RedisWorkflowQueue } from '../../src/adapters/redis/queue.ts'
import { defineWorkflow, implementWorkflow } from '../../src/index.ts'
import { runWorkflowWorker } from '../../src/runtime/index.ts'
import { createTestContainer, matchingKeys, wait } from './helpers.ts'

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
    `Redis queue regressions against ${target.name}`,
    () => {
      const clients: (Redis | Valkey)[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        vi.restoreAllMocks()
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

      it('preserves expired deliveries while coalescing the latest pending payload', async () => {
        const { runtime } = createHarness({ maxDeliveries: 2 })
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
        const second = { ...first, generation: 2 }
        const latest = { ...first, generation: 3 }
        const worker = {
          workerId: 'coalesced',
          workflowNames: [run.workflowName],
          leaseMs: 50,
        }
        await runtime.runCoordinationExecutor.enqueue(first)
        const firstExpired = await runtime.runCoordinationExecutor.claim(worker)
        expect(firstExpired).not.toBeNull()
        await runtime.runCoordinationExecutor.enqueue(second)
        await wait(80)

        const secondExpired =
          await runtime.runCoordinationExecutor.claim(worker)
        expect(secondExpired?.command).toStrictEqual(second)
        await runtime.runCoordinationExecutor.enqueue(latest)
        await wait(80)

        const claim = await runtime.runCoordinationExecutor.claim(worker)
        expect(claim?.command).toStrictEqual(latest)
        expect(claim?.id).not.toBe(secondExpired?.id)
        await expect(
          runtime.store.listDeadCommands({ runId: run.id }),
        ).resolves.toMatchObject([
          {
            id: secondExpired?.id,
            deliveryCount: 2,
            lastError: {
              message: expect.stringContaining('lease expired without release'),
            },
          },
        ])
        await runtime.runCoordinationExecutor.ack(claim!)
        await expect(
          runtime.runCoordinationExecutor.ack(firstExpired!),
        ).rejects.toThrow('Stale')
        await expect(
          runtime.runCoordinationExecutor.ack(secondExpired!),
        ).rejects.toThrow('Stale')
        await expect(
          runtime.runCoordinationExecutor.claim(worker),
        ).resolves.toBeNull()
      })

      it('preserves failed deliveries while releasing into a fresh pending continue', async () => {
        const { runtime } = createHarness({ maxDeliveries: 2 })
        const run = await runtime.store.createRun({
          workflowName: 'released-coalesced',
          input: null,
        })
        const first = {
          kind: 'continueRun' as const,
          runId: run.id,
          workflowName: run.workflowName,
          generation: 1,
        }
        const second = { ...first, generation: 2 }
        const latest = { ...first, generation: 3 }
        const worker = {
          workerId: 'released-coalesced',
          workflowNames: [run.workflowName],
          leaseMs: 30_000,
        }

        await runtime.runCoordinationExecutor.enqueue(first)
        const firstClaim = await runtime.runCoordinationExecutor.claim(worker)
        await runtime.runCoordinationExecutor.enqueue(second)
        await runtime.runCoordinationExecutor.release(firstClaim!, {
          error: new Error('first failure'),
        })

        const secondClaim = await runtime.runCoordinationExecutor.claim(worker)
        expect(secondClaim?.command).toStrictEqual(second)
        await runtime.runCoordinationExecutor.enqueue(latest)
        await runtime.runCoordinationExecutor.release(secondClaim!, {
          error: new Error('second failure'),
        })

        await expect(
          runtime.store.listDeadCommands({ runId: run.id }),
        ).resolves.toMatchObject([
          {
            id: secondClaim?.id,
            deliveryCount: 2,
            lastError: { message: 'second failure' },
          },
        ])
        const pending = await runtime.runCoordinationExecutor.claim(worker)
        expect(pending?.command).toStrictEqual(latest)
        await runtime.runCoordinationExecutor.ack(pending!)
      })

      it('restores continuation dedup after requeueing dead work', async () => {
        const { client, keys, runtime } = createHarness({ maxDeliveries: 1 })
        const run = await runtime.store.createRun({
          workflowName: 'requeued-dedup',
          input: null,
        })
        const first = {
          kind: 'continueRun' as const,
          runId: run.id,
          workflowName: run.workflowName,
          generation: 1,
        }
        const second = { ...first, generation: 2 }
        const latest = { ...first, generation: 3 }
        const worker = {
          workerId: 'requeued-dedup',
          workflowNames: [run.workflowName],
          leaseMs: 30_000,
        }

        await runtime.runCoordinationExecutor.enqueue(first)
        const failed = await runtime.runCoordinationExecutor.claim(worker)
        await runtime.runCoordinationExecutor.enqueue(second)
        await runtime.runCoordinationExecutor.release(failed!, {
          error: new Error('dead continuation'),
        })
        const pending = await runtime.runCoordinationExecutor.claim(worker)
        await runtime.runCoordinationExecutor.ack(pending!)

        const [dead] = await runtime.store.listDeadCommands({ runId: run.id })
        await runtime.store.requeueDeadCommand(dead!.id)
        expect(await client.hget(keys.queue('continue').dedup, run.id)).toBe(
          dead!.id,
        )

        await runtime.runCoordinationExecutor.enqueue(latest)
        const requeued = await runtime.runCoordinationExecutor.claim(worker)
        expect(requeued?.id).toBe(dead!.id)
        expect(requeued?.command).toStrictEqual(latest)
        await runtime.runCoordinationExecutor.ack(requeued!)
        await expect(
          runtime.runCoordinationExecutor.claim(worker),
        ).resolves.toBeNull()
      })

      it('drains routed work without traversing unrelated ready commands', async () => {
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

        const monitor = await client.monitor()
        const commands: string[][] = []
        monitor.on('monitor', (_time: unknown, args: string[]) =>
          commands.push(args),
        )
        try {
          await runWorkflowWorker({
            ...runtime,
            container: createTestContainer(),
            workflows: [implementation],
            workerId: 'full-scan-worker',
          })

          const snapshot = await runtime.store.loadRunSnapshot(run.id)
          expect(snapshot?.run.status).toBe('completed')
          expect(snapshot?.run.output).toStrictEqual({ value: 'target' })
          await client.echo('drained')
          await expect
            .poll(() =>
              commands.some(
                ([name, value]) =>
                  name?.toLowerCase() === 'echo' && value === 'drained',
              ),
            )
            .toBe(true)
          const queue = keys.queue('continue')
          const queueReads = commands.filter(
            ([name, key]) =>
              name?.toLowerCase() === 'hget' && key === queue.items,
          )
          expect(queueReads.length).toBeLessThan(20)
          expect(await client.zcard(queue.ready)).toBe(600)
        } finally {
          monitor.disconnect()
        }
      })

      it('continues past a full batch of expired-family commands on its own route', async () => {
        const { client, keys, runtime } = createHarness({
          terminalRetentionMs: 20,
        })
        const ids = await Promise.all(
          Array.from({ length: 150 }, async () => {
            const run = await runtime.store.createRun({
              workflowName: 'orphan-heads',
              input: null,
            })
            await runtime.runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId: run.id,
              workflowName: run.workflowName,
            })
            await runtime.store.completeRun({ runId: run.id, output: null })
            return run.id
          }),
        )
        await waitUntil(
          async () =>
            (await client.exists(...ids.map((id) => keys.family(id)))) === 0,
        )
        const live = await runtime.store.createRun({
          workflowName: 'orphan-heads',
          input: null,
        })
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: live.id,
          workflowName: live.workflowName,
        })
        const claim = await runtime.runCoordinationExecutor.claim({
          workerId: 'orphan-heads',
          workflowNames: [live.workflowName],
          leaseMs: 1000,
        })
        expect(claim?.command.runId).toBe(live.id)
        await runtime.runCoordinationExecutor.ack(claim!)
        expect(await client.hlen(keys.queue('continue').items)).toBe(0)
      })

      it('checks an empty route in constant calls despite an unrelated backlog', async () => {
        const { client, runtime } = createHarness()
        await Promise.all(
          Array.from({ length: 2000 }, () =>
            runtime.runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId: randomUUID(),
              workflowName: 'offline',
            }),
          ),
        )
        const evalsha = vi.spyOn(client, 'evalsha')
        expect(
          await runtime.runCoordinationExecutor.claim({
            workerId: 'idle',
            workflowNames: ['empty'],
            leaseMs: 1000,
          }),
        ).toBeNull()
        expect(evalsha.mock.calls.length).toBeLessThanOrEqual(2)
      })

      it('indexes wildcard and exact activity selectors without name collisions', async () => {
        const { runtime } = createHarness()
        const first = activityCommand(randomUUID(), 'a:b', 'c')
        const second = activityCommand(randomUUID(), 'a', 'b:c')
        const unicode = activityCommand(randomUUID(), '工作:🧩', '')
        for (const command of [first, second, unicode])
          await runtime.attemptExecutor.dispatchActivity(command)
        expect(
          await runtime.attemptExecutor.claim({
            workerId: 'none',
            workflowNames: ['a'],
            activityNames: [],
            taskNames: [],
            leaseMs: 1000,
          }),
        ).toBeNull()
        const exact = await runtime.attemptExecutor.claim({
          workerId: 'exact',
          workflowNames: ['a'],
          activityNames: ['b:c'],
          taskNames: [],
          leaseMs: 1000,
        })
        expect(exact?.command).toStrictEqual(second)
        await runtime.attemptExecutor.ack(exact!)
        const wildcard = await runtime.attemptExecutor.claim({
          workerId: 'wildcard',
          workflowNames: ['a:b'],
          taskNames: [],
          leaseMs: 1000,
        })
        expect(wildcard?.command).toStrictEqual(first)
        await runtime.attemptExecutor.ack(wildcard!)
        const last = await runtime.attemptExecutor.claim({
          workerId: 'unicode',
          workflowNames: ['工作:🧩'],
          activityNames: [''],
          taskNames: [],
          leaseMs: 1000,
        })
        expect(last?.command).toStrictEqual(unicode)
        await runtime.attemptExecutor.ack(last!)
      })

      it('does not starve an older command on a later route', async () => {
        const { runtime } = createHarness()
        const older = {
          kind: 'continueRun' as const,
          runId: randomUUID(),
          workflowName: 'second',
        }
        const later = {
          kind: 'continueRun' as const,
          runId: randomUUID(),
          workflowName: 'first',
        }
        const now = Date.now()
        await runtime.runCoordinationExecutor.enqueueDelayed(
          older,
          new Date(now - 1000),
        )
        await runtime.runCoordinationExecutor.enqueueDelayed(
          later,
          new Date(now - 500),
        )
        const claim = await runtime.runCoordinationExecutor.claim({
          workerId: 'fair',
          workflowNames: ['first', 'second'],
          leaseMs: 1000,
        })
        expect(claim?.command).toStrictEqual(older)
        await runtime.runCoordinationExecutor.ack(claim!)
      })

      it('renews the routed lease deadline before reclaiming', async () => {
        const { runtime } = createHarness()
        const command = activityCommand(randomUUID(), 'renewed', 'activity')
        await runtime.attemptExecutor.dispatchActivity(command)
        const worker = {
          workerId: 'renewed',
          workflowNames: ['renewed'],
          taskNames: [],
          leaseMs: 100,
        }
        const claim = await runtime.attemptExecutor.claim(worker)
        expect(claim).not.toBeNull()
        await runtime.attemptExecutor.heartbeat(claim!, 2000)
        await wait(150)
        expect(await runtime.attemptExecutor.claim(worker)).toBeNull()
        await runtime.attemptExecutor.ack(claim!)
      })

      it('reclaims expired routes without sequential client-side item reads', async () => {
        const { client, keyPrefix, keys, runtime } = createHarness()
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
        const routeKeys = await matchingKeys(
          client,
          `${keyPrefix}queue:continue:route:*:claimed`,
        )
        expect(routeKeys).toHaveLength(1)
        await Promise.all(
          ids.map(async (id) => {
            await client.zadd(claimedKey, 0, id)
            await client.zadd(routeKeys[0]!, 0, id)
          }),
        )

        const mutableClient = client as unknown as { hget: HgetCommand }
        const hget = mutableClient.hget.bind(client)
        let hgetCalls = 0
        mutableClient.hget = async (...arguments_) => {
          hgetCalls += 1
          return await hget(...arguments_)
        }

        const evalsha = vi.spyOn(client, 'evalsha')
        await expect(
          runtime.runCoordinationExecutor.claim({
            workerId: 'other-worker',
            workflowNames: ['other-route'],
            leaseMs: 1_000,
          }),
        ).resolves.toBeNull()
        expect(hgetCalls).toBe(0)
        expect(evalsha.mock.calls.length).toBeLessThanOrEqual(2)
        expect(await client.zcard(claimedKey)).toBe(300)
      })

      it('deletes only matching unclaimed attempts without client-side item reads', async () => {
        const { client, keys, runtime } = createHarness()
        const targetRunId = randomUUID()
        const unrelatedRunId = randomUUID()
        const claimed = activityCommand(
          targetRunId,
          'cleanup-workflow',
          'claimed',
        )
        const target = activityCommand(
          targetRunId,
          'cleanup-workflow',
          'target',
        )
        const unrelated = activityCommand(
          unrelatedRunId,
          'cleanup-workflow',
          'unrelated',
        )
        await runtime.attemptExecutor.dispatchActivity(claimed)
        const claimedAttempt = await runtime.attemptExecutor.claim({
          workerId: 'cleanup-claimed-worker',
          workflowNames: ['cleanup-workflow'],
          activityNames: ['claimed'],
          taskNames: [],
          leaseMs: 30_000,
        })
        await runtime.attemptExecutor.dispatchActivity(target)
        await runtime.attemptExecutor.dispatchActivity(unrelated)

        const mutableClient = client as unknown as { hget: HgetCommand }
        const hget = mutableClient.hget.bind(client)
        let hgetCalls = 0
        mutableClient.hget = async (...arguments_) => {
          hgetCalls += 1
          return await hget(...arguments_)
        }

        await expect(
          runtime.attemptExecutor.deleteUnclaimed({ runId: targetRunId }),
        ).resolves.toBe(1)
        expect(hgetCalls).toBe(0)
        const queue = keys.queue('attempt')
        expect(await client.zcard(queue.ready)).toBe(1)
        expect(await client.zcard(queue.claimed)).toBe(1)

        await runtime.attemptExecutor.ack(claimedAttempt!)
        const unrelatedAttempt = await runtime.attemptExecutor.claim({
          workerId: 'cleanup-unrelated-worker',
          workflowNames: ['cleanup-workflow'],
          activityNames: ['unrelated'],
          taskNames: [],
          leaseMs: 30_000,
        })
        expect(unrelatedAttempt?.command).toStrictEqual(unrelated)
        await runtime.attemptExecutor.ack(unrelatedAttempt!)
        await expect(
          runtime.attemptExecutor.claim({
            workerId: 'cleanup-target-worker',
            workflowNames: ['cleanup-workflow'],
            activityNames: ['target'],
            taskNames: [],
            leaseMs: 30_000,
          }),
        ).resolves.toBeNull()
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

      it.each([1, 300])(
        'maintenance removes commands and indexes with %i ready attempts on abandoned routes',
        async (readyCount) => {
          const { client, keyPrefix, keys, runtime } = createHarness({
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

          await Promise.all(
            Array.from({ length: readyCount }, (_, index) =>
              runtime.attemptExecutor.dispatchActivity(
                activityCommand(run.id, run.workflowName, `ready-${index}`),
              ),
            ),
          )
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

          const evalsha = vi.spyOn(client, 'evalsha')
          await runtime.store.pruneTerminalRuns({ olderThan: new Date() })

          for (const kind of ['continue', 'attempt'] as const) {
            const queue = keys.queue(kind)
            // One round removes this small backlog, then a clean pass verifies it.
            const cleanupCalls = evalsha.mock.calls.filter((args) =>
              args.includes(queue.items),
            )
            if (readyCount === 1 || kind === 'continue') {
              expect(cleanupCalls.length).toBeLessThanOrEqual(2)
            }
            expect(await client.hlen(queue.items)).toBe(0)
            expect(await client.zcard(queue.ready)).toBe(0)
            expect(await client.zcard(queue.claimed)).toBe(0)
            expect(await client.zcard(queue.dead)).toBe(0)
            expect(await client.hlen(queue.dedup)).toBe(0)
          }
          const remaining = await matchingKeys(client, `${keyPrefix}queue:*`)
          expect(remaining).toEqual([])
        },
      )

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
