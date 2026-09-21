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

// Larger than the base cleanup batch of 1,000 ids, which is what let a family
// leave more expired ids behind than the next transition removed.
const FAMILY_CHILDREN = 1200
const FAMILY_SIZE = FAMILY_CHILDREN + 1

for (const target of targets) {
  describe.skipIf(!target.url)(
    `Redis fourth review regressions against ${target.name}`,
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
        const keyPrefix = `nmtjs:test:review4-redis:${randomUUID()}:`
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

      type Store = ReturnType<typeof createRedisWorkflowRuntime>['store']

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
        const { client, runtime, ordered, terminal } = createHarness(100)
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
        expect(await client.zrange(ordered, '-inf', '+inf', 'BYSCORE')).toEqual(
          [active.id, first.id, second.id],
        )
        expect(
          (await client.zrange(terminal, '-inf', '+inf', 'BYSCORE')).sort(),
        ).toEqual([first.id, second.id].sort())
      }, 60_000)

      it('removes more expired ids than one ZREM call can take', async () => {
        const { client, runtime, ordered, terminal } = createHarness(60_000)
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
    },
  )
}
