import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  RedisWorkflowRuntime,
  WorkflowRedisClient,
} from '../../src/adapters/redis.ts'
import type { RunCoordinationWorkerClaim } from '../../src/runtime/commands.ts'
import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { RedisWorkflowKeys } from '../../src/adapters/redis/keys.ts'
import { RedisWorkflowWakeEvents } from '../../src/adapters/redis/wake-events.ts'

type ServiceTarget = {
  readonly name: string
  readonly url: string | undefined
  readonly proxyName: string
  readonly proxyUrl: string | undefined
  readonly proxyListen: string
  readonly proxyUpstream: string
  readonly createClient: (
    url?: string,
    commandTimeout?: number,
    maxRetriesPerRequest?: number,
  ) => Redis | Valkey
}

const targets: readonly ServiceTarget[] = [
  {
    name: 'Redis',
    url: process.env.REDIS_URL,
    proxyName: 'workflows-redis',
    proxyUrl: process.env.REDIS_PROXY_URL,
    proxyListen: '0.0.0.0:6382',
    proxyUpstream: process.env.REDIS_PROXY_UPSTREAM ?? 'redis:6379',
    createClient: (
      url = process.env.REDIS_URL!,
      commandTimeout = 2_000,
      maxRetriesPerRequest = 1,
    ) =>
      new Redis(url, {
        maxRetriesPerRequest,
        commandTimeout,
      }),
  },
  {
    name: 'Valkey',
    url: process.env.VALKEY_URL,
    proxyName: 'workflows-valkey',
    proxyUrl: process.env.VALKEY_PROXY_URL,
    proxyListen: '0.0.0.0:6383',
    proxyUpstream: process.env.VALKEY_PROXY_UPSTREAM ?? 'valkey:6379',
    createClient: (
      url = process.env.VALKEY_URL!,
      commandTimeout = 2_000,
      maxRetriesPerRequest = 1,
    ) =>
      new Valkey(url, {
        maxRetriesPerRequest,
        commandTimeout,
      }),
  },
]

describe('Redis workflow wake subscriptions', () => {
  it('contains subscription failures and retries after reconnect', async () => {
    const subscriber = new EventEmitter() as EventEmitter & {
      status: string
      subscribe: (channel: string) => Promise<unknown>
      unsubscribe: (channel: string) => Promise<unknown>
      quit: () => Promise<unknown>
    }
    subscriber.status = 'ready'
    subscriber.subscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error('Injected subscription failure'))
      .mockResolvedValue(undefined)
    subscriber.unsubscribe = vi
      .fn()
      .mockRejectedValue(new Error('Injected unsubscribe failure'))
    subscriber.quit = vi.fn().mockResolvedValue(undefined)
    const client = {
      duplicate: () => subscriber,
    } as unknown as WorkflowRedisClient
    const events = new RedisWorkflowWakeEvents(
      client,
      new RedisWorkflowKeys(`nmtjs:test:wakes:${randomUUID()}:`),
    )

    const unsubscribe = events.onCommand('continue', () => {})
    await wait(0)
    subscriber.emit('ready')
    await wait(0)

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2)
    unsubscribe()
    await events.dispose()
  })
})

for (const target of targets) {
  if (!target.url && process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
    throw new Error(`${target.name} integration tests require a service URL`)
  }
  if (
    process.env.NMTJS_REQUIRE_REDIS_RESILIENCE_TESTS === '1' &&
    (!target.proxyUrl || !process.env.TOXIPROXY_URL)
  ) {
    throw new Error(
      `${target.name} resilience tests require its proxy URL and TOXIPROXY_URL`,
    )
  }

  describe.skipIf(!target.url)(
    `Redis workflow runtime against ${target.name}`,
    () => {
      const clients: Array<Redis | Valkey> = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        await Promise.allSettled(
          runtimes.splice(0).map(async (runtime) => await runtime.dispose?.()),
        )
        await Promise.allSettled(
          clients.splice(0).map(async (client) => await client.quit()),
        )
      })

      const createHarness = (
        terminalRetentionMs = 5_000,
        client = target.createClient(),
        keyPrefix = `nmtjs:test:workflows:${randomUUID()}:`,
      ) => {
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          terminalRetentionMs,
          maxDeliveries: 3,
        })
        clients.push(client)
        runtimes.push(runtime)
        return { client, keyPrefix, runtime }
      }

      it('routes, delays, leases, and acknowledges commands', async () => {
        const { runtime } = createHarness()
        const immediate = {
          kind: 'continueRun',
          runId: randomUUID(),
          workflowName: 'chat-stream',
        } as const
        const delayed = {
          ...immediate,
          runId: randomUUID(),
        }

        await runtime.runCoordinationExecutor.enqueue(immediate)
        await runtime.runCoordinationExecutor.enqueueDelayed(
          delayed,
          new Date(Date.now() + 80),
        )

        expect(
          await runtime.runCoordinationExecutor.claim({
            workerId: 'wrong-worker',
            workflowNames: ['other'],
            leaseMs: 1_000,
          }),
        ).toBeNull()

        const first = await runtime.runCoordinationExecutor.claim({
          workerId: 'worker-1',
          workflowNames: ['chat-stream'],
          leaseMs: 1_000,
        })
        expect(first?.command).toStrictEqual(immediate)
        await runtime.runCoordinationExecutor.ack(first!)

        expect(
          await runtime.runCoordinationExecutor.claim({
            workerId: 'worker-1',
            workflowNames: ['chat-stream'],
            leaseMs: 1_000,
          }),
        ).toBeNull()

        await wait(100)
        const second = await runtime.runCoordinationExecutor.claim({
          workerId: 'worker-1',
          workflowNames: ['chat-stream'],
          leaseMs: 1_000,
        })
        expect(second?.command).toStrictEqual(delayed)
        await runtime.runCoordinationExecutor.ack(second!)
      })

      it('recovers an expired lease and fences its stale acknowledgement', async () => {
        const { runtime } = createHarness()
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: randomUUID(),
          workflowName: 'recoverable',
        })
        const worker = {
          workerId: 'worker',
          workflowNames: ['recoverable'],
          leaseMs: 30,
        }
        const stale = await runtime.runCoordinationExecutor.claim(worker)
        await wait(50)
        const recovered = await runtime.runCoordinationExecutor.claim(worker)

        expect(recovered?.id).toBe(stale?.id)
        expect(recovered?.leaseToken).not.toBe(stale?.leaseToken)
        await expect(
          runtime.runCoordinationExecutor.ack(stale!),
        ).rejects.toThrow('Stale workflow command ack')
        await runtime.runCoordinationExecutor.ack(recovered!)
      })

      it('claims unrelated commands concurrently without duplicate delivery', async () => {
        const { runtime } = createHarness()
        const commands = Array.from({ length: 24 }, (_, index) => ({
          kind: 'continueRun' as const,
          runId: randomUUID(),
          workflowName: 'parallel',
          index,
        }))
        await Promise.all(
          commands.map(
            async (command) =>
              await runtime.runCoordinationExecutor.enqueue(command),
          ),
        )

        const claims = await Promise.all(
          commands.map(
            async (_, index) =>
              await runtime.runCoordinationExecutor.claim({
                workerId: `worker-${index}`,
                workflowNames: ['parallel'],
                leaseMs: 1_000,
              }),
          ),
        )
        expect(claims.every((claim) => claim !== null)).toBe(true)
        expect(new Set(claims.map((claim) => claim!.id)).size).toBe(
          commands.length,
        )
        await Promise.all(
          claims.map(
            async (claim) => await runtime.runCoordinationExecutor.ack(claim!),
          ),
        )
      })

      it('selects routed claims inside Redis without per-candidate reads', async () => {
        const { client, runtime } = createHarness()
        const unrelated = Array.from({ length: 300 }, () => ({
          kind: 'continueRun' as const,
          runId: randomUUID(),
          workflowName: 'unrelated',
        }))
        await Promise.all(
          unrelated.map(async (command) => {
            await runtime.runCoordinationExecutor.enqueue(command)
          }),
        )
        const expectedRunId = randomUUID()
        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: expectedRunId,
          workflowName: 'routed',
        })

        const mutableClient = client as unknown as { hget: HgetCommand }
        const hget = mutableClient.hget.bind(client)
        let hgetCalls = 0
        mutableClient.hget = async (...arguments_) => {
          hgetCalls += 1
          return await hget(...arguments_)
        }

        const worker = {
          workerId: 'routed-worker',
          workflowNames: ['routed'],
          leaseMs: 1_000,
        }
        let claim = await runtime.runCoordinationExecutor.claim(worker)
        for (let scan = 1; !claim && scan < 8; scan += 1) {
          claim = await runtime.runCoordinationExecutor.claim(worker)
        }

        expect(claim?.command.runId).toBe(expectedRunId)
        expect(hgetCalls).toBe(0)
        await runtime.runCoordinationExecutor.ack(claim!)
      })

      it('deduplicates contended enqueue operations inside Redis', async () => {
        const { runtime } = createHarness()
        const runId = randomUUID()
        await Promise.all(
          Array.from({ length: 32 }, async () => {
            await runtime.runCoordinationExecutor.enqueue({
              kind: 'continueRun',
              runId,
              workflowName: 'contended-enqueue',
            })
          }),
        )

        const worker = {
          workerId: 'contention-worker',
          workflowNames: ['contended-enqueue'],
          leaseMs: 1_000,
        }
        const claim = await runtime.runCoordinationExecutor.claim(worker)
        expect(claim?.command.runId).toBe(runId)
        await runtime.runCoordinationExecutor.ack(claim!)
        await expect(
          runtime.runCoordinationExecutor.claim(worker),
        ).resolves.toBeNull()
      })

      it('creates one idempotent run under contention', async () => {
        const { runtime } = createHarness()
        const input = {
          workflowName: 'contended-start',
          input: { requestId: 'request-1' },
          idempotencyKey: ['request', 'request-1'],
        } as const

        const runs = await Promise.all(
          Array.from(
            { length: 32 },
            async () => await runtime.store.createRun(input),
          ),
        )
        expect(new Set(runs.map((run) => run.id)).size).toBe(1)
      })

      it('admits one active unique run under contention', async () => {
        const { runtime } = createHarness()
        const input = {
          workflowName: 'contended-unique-start',
          input: null,
          unique: {
            key: ['conversation', 'conversation-1'],
            scope: 'active',
            behavior: 'reject',
          },
        } as const

        const starts = await Promise.allSettled(
          Array.from(
            { length: 32 },
            async () => await runtime.store.createRun(input),
          ),
        )
        let admitted = 0
        let rejected = 0
        for (const start of starts) {
          if (start.status === 'fulfilled') admitted += 1
          else rejected += 1
        }
        expect(admitted).toBe(1)
        expect(rejected).toBe(31)
      })

      it('deduplicates starts and releases active uniqueness at terminal state', async () => {
        const { runtime } = createHarness()
        const input = {
          workflowName: 'chat-stream',
          input: { conversationId: 'conversation-1' },
          idempotencyKey: ['request', 'request-1'],
          unique: {
            key: ['conversation', 'conversation-1'],
            scope: 'active',
            behavior: 'reject',
          },
        } as const

        const first = await runtime.store.createRun(input)
        const replay = await runtime.store.createRun(input)
        expect(replay.id).toBe(first.id)

        await expect(
          runtime.store.createRun({
            ...input,
            idempotencyKey: ['request', 'request-2'],
          }),
        ).rejects.toThrow()

        await runtime.store.completeRun({ runId: first.id, output: 'done' })
        const next = await runtime.store.createRun({
          ...input,
          idempotencyKey: ['request', 'request-2'],
        })
        expect(next.id).not.toBe(first.id)
      })

      it('repairs an idempotent create-before-dispatch interruption', async () => {
        const { runtime } = createHarness()
        const runInput = {
          workflowName: 'repair-start',
          input: { requestId: 'request-1' },
          idempotencyKey: ['request', 'request-1'],
        } as const
        const stored = await runtime.store.createRun(runInput)

        const replay = await runtime.atomicStart!.startWorkflowRun({
          run: runInput,
        })
        expect(replay.id).toBe(stored.id)

        const claim = await runtime.runCoordinationExecutor.claim({
          workerId: 'repair-worker',
          workflowNames: ['repair-start'],
          leaseMs: 1_000,
        })
        expect(claim?.command.runId).toBe(stored.id)
        await runtime.runCoordinationExecutor.ack(claim!)

        await runtime.atomicStart!.startWorkflowRun({ run: runInput })
        await expect(
          runtime.runCoordinationExecutor.claim({
            workerId: 'repair-worker',
            workflowNames: ['repair-start'],
            leaseMs: 1_000,
          }),
        ).resolves.toBeNull()
      })

      it('preserves a workflow start when enqueue times out after commit', async () => {
        const { client, keyPrefix, runtime } = createHarness()
        failOnceAfterEvalshaForKey(client, `${keyPrefix}queue:continue:items`)

        const run = await runtime.atomicStart!.startWorkflowRun({
          run: {
            workflowName: 'ambiguous-workflow-start',
            input: null,
            idempotencyKey: ['start', 'ambiguous-workflow'],
          },
        })

        expect(run.status).toBe('queued')
        const claim = await runtime.runCoordinationExecutor.claim({
          workerId: 'ambiguous-workflow-worker',
          workflowNames: ['ambiguous-workflow-start'],
          leaseMs: 1_000,
        })
        expect(claim?.command.runId).toBe(run.id)
        await runtime.runCoordinationExecutor.ack(claim!)
      })

      it('preserves a task start when dispatch times out after commit', async () => {
        const { client, keyPrefix, runtime } = createHarness()
        failOnceAfterEvalshaForKey(client, `${keyPrefix}queue:attempt:items`)

        const run = await runtime.atomicStart!.startTaskRun({
          run: {
            kind: 'task',
            name: 'ambiguous-task-start',
            workflowName: 'ambiguous-task-start',
            taskName: 'ambiguous-task-start',
            input: null,
            idempotencyKey: ['start', 'ambiguous-task'],
          },
          taskName: 'ambiguous-task-start',
          taskInput: null,
          idempotencyKey: ['start', 'ambiguous-task'],
        })

        expect(run.status).toBe('queued')
        const claim = await runtime.attemptExecutor.claim({
          workerId: 'ambiguous-task-worker',
          workflowNames: [],
          taskNames: ['ambiguous-task-start'],
          leaseMs: 1_000,
        })
        expect(claim?.command.runId).toBe(run.id)
        await runtime.attemptExecutor.ack(claim!)
      })

      it('retains active families without TTL and expires the complete family', async () => {
        const { client, keyPrefix, runtime } = createHarness(2_000)
        const root = await runtime.store.createRun({
          workflowName: 'root',
          input: null,
        })
        await runtime.store.createNode({
          runId: root.id,
          name: 'child',
          kind: 'workflow',
        })
        await runtime.store.ensureNodeChildren({
          runId: root.id,
          nodeName: 'child',
          children: [{ childKey: 'only', kind: 'workflow' }],
        })
        const { childRun } = await runtime.store.ensureChildRun({
          runId: root.id,
          nodeName: 'child',
          childKey: 'only',
          childKind: 'workflow',
          childName: 'child',
          input: null,
          rootRunId: root.id,
        })
        const familyKey = `${keyPrefix}family:${root.id}`

        expect(await client.type(familyKey)).toBe('hash')
        expect(await client.pttl(familyKey)).toBe(-1)
        await runtime.store.completeRun({ runId: childRun.id, output: null })
        expect(await client.pttl(familyKey)).toBe(-1)
        expect(
          (await runtime.store.listRuns()).runs.map((run) => run.id),
        ).toContain(childRun.id)

        await runtime.store.completeRun({ runId: root.id, output: null })
        expect(await client.pttl(familyKey)).toBeGreaterThan(0)
        expect(await client.pttl(familyKey)).toBeLessThanOrEqual(2_000)
        expect(await client.pttl(`${familyKey}:runs`)).toBeGreaterThan(0)
        expect(await client.pttl(`${familyKey}:nodes`)).toBeGreaterThan(0)
        expect(await client.pttl(`${familyKey}:children`)).toBeGreaterThan(0)
      })

      it('recovers a claimed command after the worker process disappears', async () => {
        const { client, keyPrefix, runtime } = createHarness()
        const command = {
          kind: 'continueRun' as const,
          runId: randomUUID(),
          workflowName: 'worker-crash',
        }
        await runtime.runCoordinationExecutor.enqueue(command)
        const worker = {
          workerId: 'crashed-worker',
          workflowNames: ['worker-crash'],
          leaseMs: 80,
        }
        const abandoned = await runtime.runCoordinationExecutor.claim(worker)
        expect(abandoned?.command).toStrictEqual(command)

        await runtime.dispose?.()
        await client.quit()
        await wait(120)

        const replacementClient = target.createClient()
        const replacement = createHarness(
          5_000,
          replacementClient,
          keyPrefix,
        ).runtime
        const recovered = await replacement.runCoordinationExecutor.claim({
          ...worker,
          workerId: 'replacement-worker',
        })
        expect(recovered?.id).toBe(abandoned?.id)
        expect(recovered?.leaseToken).not.toBe(abandoned?.leaseToken)
        await replacement.runCoordinationExecutor.ack(recovered!)
      })

      it('reclaims a volume of terminal state after its retention window', async () => {
        const { client, keyPrefix, runtime } = createHarness(150)
        const runs = await Promise.all(
          Array.from({ length: 250 }, async (_, index) => {
            return await runtime.store.createRun({
              workflowName: 'retention-pressure',
              input: { index },
            })
          }),
        )
        await Promise.all(
          runs.map(async (run) => {
            await runtime.store.completeRun({ runId: run.id, output: null })
          }),
        )

        const familyPattern = `${keyPrefix}family:*`
        const rootPattern = `${keyPrefix}run-root:*`
        expect(await countMatchingKeys(client, familyPattern)).toBeGreaterThan(
          500,
        )
        expect(await countMatchingKeys(client, rootPattern)).toBe(runs.length)

        await waitForAsync(async () => {
          return (await countMatchingKeys(client, familyPattern)) === 0
        })
        await waitForAsync(async () => {
          return (await countMatchingKeys(client, rootPattern)) === 0
        })
        await runtime.store.listRuns()
        expect(await client.zcard(`${keyPrefix}runs:active`)).toBe(0)
        expect(await client.zcard(`${keyPrefix}runs:terminal`)).toBe(0)
      })

      it.skipIf(process.env.NMTJS_ALLOW_REDIS_MEMORY_PRESSURE_TESTS !== '1')(
        'fails explicitly under no-eviction memory pressure and recovers',
        async () => {
          const { client, keyPrefix, runtime } = createHarness()
          const originalMaxmemory = await redisConfigValue(client, 'maxmemory')
          const originalPolicy = await redisConfigValue(
            client,
            'maxmemory-policy',
          )
          const usedMemory = redisUsedMemory(await client.info('memory'))
          let pressureError: unknown

          try {
            await client.config('SET', 'maxmemory-policy', 'noeviction')
            await client.config(
              'SET',
              'maxmemory',
              String(usedMemory + 512 * 1_024),
            )
            const padding = 'x'.repeat(64 * 1_024)
            for (let index = 0; index < 100; index += 1) {
              try {
                const command = {
                  kind: 'continueRun',
                  runId: randomUUID(),
                  workflowName: 'memory-pressure',
                  padding,
                } as const
                await runtime.runCoordinationExecutor.enqueue(command)
              } catch (error) {
                pressureError = error
                break
              }
            }
            expect(pressureError).toBeInstanceOf(Error)
            expect((pressureError as Error).message).toMatch(/OOM|maxmemory/i)
          } finally {
            await client.config('SET', 'maxmemory', originalMaxmemory)
            await client.config('SET', 'maxmemory-policy', originalPolicy)
            await deleteMatchingKeys(client, `${keyPrefix}*`)
          }

          const recoveredRunId = randomUUID()
          await runtime.runCoordinationExecutor.enqueue({
            kind: 'continueRun',
            runId: recoveredRunId,
            workflowName: 'memory-pressure-recovered',
          })
          const claim = await claimContinue(runtime, {
            workerId: 'memory-pressure-worker',
            workflowNames: ['memory-pressure-recovered'],
            leaseMs: 1_000,
          })
          expect(claim?.command.runId).toBe(recoveredRunId)
          await runtime.runCoordinationExecutor.ack(claim!)
        },
      )

      it.skipIf(!target.proxyUrl || !process.env.TOXIPROXY_URL)(
        'bounds failures during a sustained disconnect and recovers cleanly',
        async () => {
          await replaceProxy(target)
          const proxyClient = target.createClient(target.proxyUrl!, 250)
          proxyClient.on('error', () => {})
          const { runtime } = createHarness(5_000, proxyClient)
          const first = {
            kind: 'continueRun' as const,
            runId: randomUUID(),
            workflowName: 'network-recovery',
          }
          const interrupted = {
            ...first,
            runId: randomUUID(),
          }
          await runtime.runCoordinationExecutor.enqueue(first)

          await setProxyEnabled(target, false)
          try {
            await wait(100)
            const startedAt = Date.now()
            await expect(
              runtime.runCoordinationExecutor.enqueue(interrupted),
            ).rejects.toThrow()
            expect(Date.now() - startedAt).toBeLessThan(1_500)
            await wait(500)
          } finally {
            await setProxyEnabled(target, true)
          }

          await waitForRedis(proxyClient)
          await runtime.runCoordinationExecutor.enqueue(interrupted)
          const worker = {
            workerId: 'network-recovery-worker',
            workflowNames: ['network-recovery'],
            leaseMs: 1_000,
          }
          const firstClaim = await claimContinue(runtime, worker)
          const secondClaim = await claimContinue(runtime, worker)
          expect(
            new Set([firstClaim?.command.runId, secondClaim?.command.runId]),
          ).toStrictEqual(new Set([first.runId, interrupted.runId]))
          await runtime.runCoordinationExecutor.ack(firstClaim!)
          await runtime.runCoordinationExecutor.ack(secondClaim!)
          await expect(
            runtime.runCoordinationExecutor.claim(worker),
          ).resolves.toBeNull()
        },
      )

      it.skipIf(process.env.NMTJS_ALLOW_REDIS_SERVICE_RESTARTS !== '1')(
        'preserves queued work and state across a service restart',
        async () => {
          const { client, runtime } = createHarness()
          client.on('error', () => {})
          const run = await runtime.store.createRun({
            workflowName: 'service-restart',
            input: { persisted: true },
          })
          await runtime.runCoordinationExecutor.enqueue({
            kind: 'continueRun',
            runId: run.id,
            workflowName: run.workflowName,
          })

          await restartService(target)
          await waitForRedis(client)

          const restored = await runtime.store.loadRunSnapshot(run.id)
          expect(restored?.run.input).toStrictEqual({ persisted: true })
          const claim = await claimContinue(runtime, {
            workerId: 'restart-worker',
            workflowNames: ['service-restart'],
            leaseMs: 1_000,
          })
          expect(claim?.command.runId).toBe(run.id)
          await runtime.runCoordinationExecutor.ack(claim!)
        },
      )

      it('uses Pub/Sub only as a wake hint over durable queue state', async () => {
        const { runtime } = createHarness()
        let wakes = 0
        const unsubscribe = runtime.wakeEvents!.onCommand('continue', () => {
          wakes += 1
        })
        await wait(50)

        await runtime.runCoordinationExecutor.enqueue({
          kind: 'continueRun',
          runId: randomUUID(),
          workflowName: 'wake',
        })
        await waitFor(() => wakes === 1)
        unsubscribe()
      })
    },
  )
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await wait(20)
  }
  throw new Error('Timed out waiting for condition')
}

async function waitForAsync(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await wait(20)
  }
  throw new Error('Timed out waiting for asynchronous condition')
}

async function countMatchingKeys(client: Redis | Valkey, pattern: string) {
  return (await matchingKeys(client, pattern)).length
}

async function matchingKeys(client: Redis | Valkey, pattern: string) {
  let cursor = '0'
  const keys: string[] = []
  do {
    const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 1_000)
    cursor = result[0]
    for (const key of result[1]) keys.push(key)
  } while (cursor !== '0')
  return keys
}

async function deleteMatchingKeys(client: Redis | Valkey, pattern: string) {
  const keys = await matchingKeys(client, pattern)
  for (let index = 0; index < keys.length; index += 100) {
    await client.del(...keys.slice(index, index + 100))
  }
}

async function redisConfigValue(client: Redis | Valkey, key: string) {
  const result = (await client.config('GET', key)) as unknown
  if (Array.isArray(result) && result.length >= 2) return String(result[1])
  if (result && typeof result === 'object' && key in result) {
    return String((result as Record<string, unknown>)[key])
  }
  throw new Error(`Redis did not return configuration [${key}]`)
}

function redisUsedMemory(info: string) {
  const match = /^used_memory:(\d+)\r?$/m.exec(info)
  if (!match) throw new Error('Redis did not report used_memory')
  return Number(match[1])
}

async function claimContinue(
  runtime: RedisWorkflowRuntime,
  worker: RunCoordinationWorkerClaim,
) {
  for (let scan = 0; scan < 16; scan += 1) {
    const claim = await runtime.runCoordinationExecutor.claim(worker)
    if (claim) return claim
  }
  return null
}

async function replaceProxy(target: ServiceTarget) {
  const response = await toxiproxyRequest(`/proxies/${target.proxyName}`, {
    method: 'DELETE',
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Toxiproxy could not remove [${target.proxyName}]: ${response.status}`,
    )
  }
  const created = await toxiproxyRequest('/proxies', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: target.proxyName,
      listen: target.proxyListen,
      upstream: target.proxyUpstream,
      enabled: true,
    }),
  })
  if (!created.ok) {
    throw new Error(
      `Toxiproxy could not create [${target.proxyName}]: ${created.status}`,
    )
  }
}

async function setProxyEnabled(target: ServiceTarget, enabled: boolean) {
  const response = await toxiproxyRequest(`/proxies/${target.proxyName}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!response.ok) {
    throw new Error(
      `Toxiproxy could not update [${target.proxyName}]: ${response.status}`,
    )
  }
}

function toxiproxyRequest(path: string, init: RequestInit) {
  const url = process.env.TOXIPROXY_URL
  if (!url) throw new Error('Missing TOXIPROXY_URL')
  return fetch(`${url}${path}`, init)
}

async function restartService(target: ServiceTarget) {
  const admin = target.createClient(target.url, 1_000, 0)
  admin.on('error', () => {})
  await admin.ping()
  try {
    await admin.shutdown('SAVE')
  } catch {
    // The server may close the socket before the successful shutdown response
    // reaches the client; availability and persisted state are verified next.
  } finally {
    admin.disconnect()
  }

  await waitForAsync(async () => {
    const probe = target.createClient(target.url, 250)
    probe.on('error', () => {})
    try {
      return (await probe.ping()) === 'PONG'
    } catch {
      return false
    } finally {
      probe.disconnect()
    }
  }, 20_000)
}

async function waitForRedis(client: Redis | Valkey) {
  await waitForAsync(async () => {
    try {
      return (await client.ping()) === 'PONG'
    } catch {
      return false
    }
  }, 10_000)
}

type EvalshaCommand = (...arguments_: readonly unknown[]) => Promise<unknown>
type HgetCommand = (...arguments_: readonly unknown[]) => Promise<string | null>

function failOnceAfterEvalshaForKey(
  client: Redis | Valkey,
  expectedFirstKey: string,
) {
  const mutableClient = client as unknown as { evalsha: EvalshaCommand }
  const evalsha = mutableClient.evalsha.bind(client)
  let shouldFail = true
  mutableClient.evalsha = async (...arguments_) => {
    const result = await evalsha(...arguments_)
    if (shouldFail && arguments_[2] === expectedFirstKey) {
      shouldFail = false
      throw new Error('Injected timeout after Redis committed the script')
    }
    return result
  }
}
