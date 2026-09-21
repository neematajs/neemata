import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { matchingKeys, wait } from './helpers.ts'

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
    `Redis third review regressions against ${target.name}`,
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

      function createHarness(terminalRetentionMs: number) {
        const client = target.createClient()
        const keyPrefix = `nmtjs:test:review3-redis:${randomUUID()}:`
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix,
          terminalRetentionMs,
        })
        clients.push(client)
        runtimes.push(runtime)
        return {
          client,
          runtime,
          ordered: `${keyPrefix}runs:ordered`,
          terminal: `${keyPrefix}runs:terminal`,
        }
      }

      async function completeFamily(
        store: ReturnType<typeof createRedisWorkflowRuntime>['store'],
      ) {
        const run = await store.createRun({
          workflowName: 'short',
          input: null,
        })
        await store.completeRun({ runId: run.id, output: null })
        return run
      }

      it('drops expired run ids from the chronological index while a run stays active', async () => {
        const { client, runtime, ordered, terminal } = createHarness(100)
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
        expect(await client.zrange(ordered, '-inf', '+inf', 'BYSCORE')).toEqual(
          [active.id, latest.id],
        )
        expect(
          await client.zrange(terminal, '-inf', '+inf', 'BYSCORE'),
        ).toEqual([latest.id])
      })

      it('keeps expiry entries until their ids left the chronological index', async () => {
        const { client, runtime, ordered, terminal } = createHarness(100)
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
        expect(await client.zrange(ordered, '-inf', '+inf', 'BYSCORE')).toEqual(
          [active.id, latest.id],
        )
        await runtime.store.completeRun({ runId: active.id, output: null })
        expect(await client.pttl(ordered)).toBeGreaterThan(0)
        expect(await client.pttl(terminal)).toBeGreaterThan(0)
        await wait(160)
        expect(await client.exists(ordered, terminal)).toBe(0)
      })

      it('bounds the expired ids one terminal transition removes', async () => {
        const { client, runtime, ordered, terminal } = createHarness(60_000)
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
        expect(await client.zcard(ordered)).toBe(502)
        expect(await client.zcard(terminal)).toBe(501)
        const second = await completeFamily(runtime.store)
        expect(await client.zrange(ordered, '-inf', '+inf', 'BYSCORE')).toEqual(
          [active.id, first.id, second.id],
        )
        expect(
          (await client.zrange(terminal, '-inf', '+inf', 'BYSCORE')).sort(),
        ).toEqual([first.id, second.id].sort())
      })
    },
  )
}
