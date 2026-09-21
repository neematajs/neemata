import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe, expect, it } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
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
    `Redis second review regressions against ${target.name}`,
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

      async function createFailedAttempt() {
        const client = target.createClient()
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix: `nmtjs:test:review2-redis:${randomUUID()}:`,
        })
        clients.push(client)
        runtimes.push(runtime)
        const { store } = runtime
        const run = await store.createRun({ workflowName: 'retry', input: {} })
        const child = {
          runId: run.id,
          nodeName: 'content',
          childKey: '$self',
        }
        await store.createNode({
          runId: run.id,
          name: child.nodeName,
          kind: 'activity',
        })
        await store.ensureNodeChildren({
          runId: run.id,
          nodeName: child.nodeName,
          children: [{ childKey: child.childKey, kind: 'activity' }],
        })
        const first = await store.createAttempt({ ...child, input: 1 })
        await expect(
          store.failCurrentAttempt({
            attemptId: first.id,
            leaseToken: first.leaseToken!,
            error: new Error('boom'),
          }),
        ).resolves.toMatchObject({ status: 'failed' })
        const load = async () =>
          (await store.loadNodeSnapshot({
            runId: run.id,
            nodeName: child.nodeName,
          }))!
        return { store, child, first, load }
      }

      it('returns the existing successor when a superseded retry is replayed', async () => {
        const { store, child, first, load } = await createFailedAttempt()

        const second = await store.createAttempt({
          ...child,
          input: 1,
          after: first.id,
        })
        expect(second).toMatchObject({ attemptNumber: 2, status: 'started' })
        const before = await load()

        // The worker that lost the claim resumes and spends the same retry.
        const replayed = await store.createAttempt({
          ...child,
          input: 1,
          after: first.id,
        })
        expect(replayed).toEqual(second)
        const snapshot = await load()
        expect(snapshot.attempts.map((attempt) => attempt.id)).toEqual([
          first.id,
          second.id,
        ])
        // Nothing was written: not even a version bump.
        expect(snapshot.children).toEqual(before.children)
        expect(snapshot.children[0]).toMatchObject({
          currentAttemptId: second.id,
          attemptCount: 2,
        })

        // The successor is a live predecessor for its own retry.
        const third = await store.createAttempt({
          ...child,
          input: 1,
          after: second.id,
        })
        expect(third).toMatchObject({ attemptNumber: 3 })
        expect((await load()).attempts).toHaveLength(3)
      })

      it('gives concurrent retries of one failure a single successor', async () => {
        const { store, child, first, load } = await createFailedAttempt()

        const created = await Promise.all(
          Array.from({ length: 8 }, () =>
            store.createAttempt({ ...child, input: 1, after: first.id }),
          ),
        )
        expect(new Set(created.map((attempt) => attempt.id)).size).toBe(1)
        const snapshot = await load()
        expect(snapshot.attempts).toHaveLength(2)
        expect(snapshot.children[0]).toMatchObject({
          currentAttemptId: created[0]!.id,
          attemptCount: 2,
        })
      })

      it('still supersedes the current attempt when no predecessor is named', async () => {
        const { store, child, load } = await createFailedAttempt()

        const second = await store.createAttempt({ ...child, input: 1 })
        const third = await store.createAttempt({ ...child, input: 1 })
        expect(third.id).not.toBe(second.id)
        expect((await load()).children[0]).toMatchObject({
          currentAttemptId: third.id,
          attemptCount: 3,
        })
      })
    },
  )
}
