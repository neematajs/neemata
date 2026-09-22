import { randomUUID } from 'node:crypto'

import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { afterEach, describe } from 'vitest'

import { createRedisWorkflowRuntime } from '../../src/adapters/redis.ts'
import { defineClaimFencingTests } from '../support/fencing.ts'
import { disposeRedisRuntimes, redisTargets } from './helpers.ts'

for (const target of redisTargets) {
  describe.skipIf(!target.url)(
    `settlement fencing by the queue claim against ${target.name}`,
    () => {
      const clients: (Redis | Valkey)[] = []
      const runtimes: ReturnType<typeof createRedisWorkflowRuntime>[] = []

      afterEach(async () => {
        await disposeRedisRuntimes(runtimes, clients)
      })

      defineClaimFencingTests((options) => {
        const client = target.createClient()
        const runtime = createRedisWorkflowRuntime({
          client,
          keyPrefix: `nmtjs:test:claim-fencing:${randomUUID()}:`,
          ...options,
        })
        clients.push(client)
        runtimes.push(runtime)
        return runtime
      })
    },
  )
}
