import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { PubSubManager } from '@nmtjs/pubsub'
import { RedisPubSubAdapter } from '@nmtjs/pubsub/redis'
import { t } from '@nmtjs/type'
import { bench, describe } from 'vitest'

import type { RedisPubSubClient } from '../src/redis.ts'
import {
  createTestLogger,
  createTestName,
  requireServiceEnv,
  serviceTargets,
  waitFor,
} from '../tests/integration/helpers.ts'

const benchmarkOptions = {
  iterations: 50,
  time: 0,
  warmupIterations: 10,
  warmupTime: 0,
}
const messagesPerSample = 20

for (const target of serviceTargets) {
  requireServiceEnv(target)

  describe.skipIf(!target.url)(`${target.name} PubSub round trip`, () => {
    const channelName = createTestName('pubsub-benchmark')
    const channel = SubscriptionContract({
      namespace: channelName,
      params: t.object({ id: t.string() }),
      events: {
        message: EventContract({ payload: t.object({ text: t.string() }) }),
      },
      key: ({ id }) => id,
    })
    const params = { id: 'room-1' }
    const payload = { text: 'benchmark' }
    let adapter: RedisPubSubAdapter | undefined
    let client: RedisPubSubClient | undefined
    let controller: AbortController | undefined
    let iterator: AsyncIterator<unknown> | undefined
    let pendingMessage: Promise<IteratorResult<unknown>> | undefined

    async function setup() {
      if (adapter) return

      try {
        client = target.createClient()
        adapter = new RedisPubSubAdapter(
          client,
          createTestLogger(`${target.name.toLowerCase()}-benchmark`),
        )
        await adapter.initialize()

        const manager = new PubSubManager({
          logger: createTestLogger(`${target.name.toLowerCase()}-benchmark`),
          adapter,
        })
        controller = new AbortController()
        const stream = await manager.subscribe(
          channel,
          params,
          undefined,
          controller.signal,
        )
        iterator = stream[Symbol.asyncIterator]()
        pendingMessage = iterator.next()

        await waitFor(async () => {
          const result = await client!.pubsub(
            'NUMSUB',
            `${channelName}:${params.id}`,
          )
          return Number(result[1] ?? 0) === 1
        })

        await manager.publish(channel.events.message, params, payload)
        const received = await pendingMessage
        if (received.done) throw new Error('PubSub benchmark stream closed')
        pendingMessage = iterator.next()

        publish = () => manager.publish(channel.events.message, params, payload)
      } catch (error) {
        await teardown()
        throw error
      }
    }

    async function teardown() {
      controller?.abort()
      await iterator?.return?.()
      await adapter?.dispose()
      await client?.quit()
      adapter = undefined
      client = undefined
      controller = undefined
      iterator = undefined
      pendingMessage = undefined
      publish = async () => false
    }

    let publish: () => Promise<boolean> = async () => false

    bench(
      `publishes and receives ${messagesPerSample} messages`,
      async () => {
        for (let index = 0; index < messagesPerSample; index++) {
          const received = pendingMessage!
          if (!(await publish())) throw new Error('PubSub publish failed')
          if ((await received).done) throw new Error('PubSub stream closed')
          pendingMessage = iterator!.next()
        }
      },
      {
        ...benchmarkOptions,
        setup,
        teardown: (_task, mode) => {
          if (mode === 'run') return teardown()
        },
      },
    )
  })
}
