import { randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { Redis as Valkey } from 'iovalkey'
import { afterEach, describe } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { defineClaimFencingTests } from '../support/fencing.ts'
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
    `settlement fencing by the queue claim against ${target.name}`,
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

      defineClaimFencingTests((options) => {
        const client = target.createClient()
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix: `nmtjs:test:review-fencing:${randomUUID()}:`,
          ...options,
        })
        clients.push(client)
        runtimes.push(runtime)
        return runtime
      })
    },
  )
}
