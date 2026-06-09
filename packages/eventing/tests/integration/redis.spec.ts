import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { Container } from '@nmtjs/core'
import { EventingRunner, implement } from '@nmtjs/eventing'
import { t } from '@nmtjs/type'
import { afterEach, describe, expect, it } from 'vitest'

import type { RedisStreamsEventingClient } from '../../src/redis.ts'
import { RedisStreamsEventingAdapter } from '../../src/redis.ts'
import {
  createTestLogger,
  createTestName,
  redisServiceTargets,
  requireRedisServiceEnv,
  waitFor,
} from './helpers.ts'

for (const target of redisServiceTargets) {
  requireRedisServiceEnv(target)

  describe.skipIf(!target.url)(
    `@nmtjs/eventing ${target.name} Streams integration`,
    () => {
      const clients: RedisStreamsEventingClient[] = []
      const adapters: RedisStreamsEventingAdapter[] = []
      const streams = new Set<string>()

      afterEach(async () => {
        await Promise.allSettled(
          adapters.splice(0).map((adapter) => adapter.dispose()),
        )
        await Promise.allSettled(
          [...streams].map((stream) => clients[0]?.del(stream)),
        )
        streams.clear()
        await Promise.allSettled(
          clients.splice(0).map((client) => client.quit()),
        )
      })

      it('recovers pending messages and dead-letters poison messages', async () => {
        const topic = createTestName('events-redis')
        const dlq = `${topic}.dlq`
        streams.add(topic)
        streams.add(dlq)
        const groupId = createTestName('group')
        const consumerId = 'consumer-1'
        const stream = SubscriptionContract({
          namespace: topic,
          params: t.object({ id: t.string() }),
          key: ({ id }) => id,
          events: {
            userCreated: EventContract({
              payload: t.object({ id: t.string() }),
            }),
          },
        })
        const event = stream.events.userCreated
        const client = target.createClient()
        clients.push(client)
        const adapter = new RedisStreamsEventingAdapter({
          client,
          logger: createTestLogger('eventing-redis'),
          blockMs: 25,
        })
        adapters.push(adapter)
        await adapter.initialize()

        await adapter.produce({
          topic,
          name: event.event,
          key: 'user-1',
          payload: { id: 'user-1' },
          headers: {},
        })

        const failingConsumer = await adapter.consume(
          { topics: [topic], groupId, consumerId, from: 'earliest' },
          async () => {
            throw new Error('first failure')
          },
        )
        await expect(failingConsumer.closed).rejects.toThrow('first failure')
        await expectPendingCount(client, topic, groupId, 1)

        const recovered: unknown[] = []
        const recoveredController = new AbortController()
        const recoveredConsumer = await adapter.consume(
          {
            topics: [topic],
            groupId,
            consumerId,
            from: 'earliest',
            signal: recoveredController.signal,
          },
          async (message) => {
            recovered.push(message.payload)
            recoveredController.abort()
          },
        )
        await recoveredConsumer.closed
        expect(recovered).toEqual([{ id: 'user-1' }])
        await expectPendingCount(client, topic, groupId, 0)

        await adapter.produce({
          topic,
          name: event.event,
          key: 'user-2',
          payload: { id: 'user-2' },
          headers: {},
        })
        const dlqConsumer = await adapter.consume(
          {
            topics: [topic],
            groupId,
            consumerId,
            from: 'earliest',
            deadLetter: { topic: dlq },
          },
          async () => {
            throw new Error('poison')
          },
        )

        await waitFor(async () => (await client.xlen(dlq)) === 1)
        await dlqConsumer.close()
        await expectPendingCount(client, topic, groupId, 0)
        const dlqMessages = (await client.xrange(dlq, '-', '+')) as Array<
          [string, string[]]
        >
        expect(
          Object.fromEntries(chunkPairs(dlqMessages[0]![1])),
        ).toMatchObject({
          sourceTopic: topic,
          name: event.event,
          key: 'user-2',
        })
      })

      it('retries subscription handlers before acknowledging delivered messages', async () => {
        const topic = createTestName('events-redis-retry')
        streams.add(topic)
        const stream = SubscriptionContract({
          namespace: topic,
          params: t.object({ id: t.string() }),
          key: ({ id }) => id,
          events: {
            userCreated: EventContract({
              payload: t.object({ id: t.string() }),
            }),
          },
        })
        const events = implement(stream)
        let attempts = 0
        const handled: unknown[] = []
        const client = target.createClient()
        clients.push(client)
        const adapter = new RedisStreamsEventingAdapter({
          client,
          logger: createTestLogger('eventing-redis-retry'),
          blockMs: 25,
        })
        const container = new Container({
          logger: createTestLogger('eventing-redis-retry-container'),
        })
        const runner = new EventingRunner(
          { logger: createTestLogger('eventing-redis-retry'), container },
          { adapter },
        )

        try {
          await runner.start({
            consumers: [
              events(
                {
                  userCreated: events.userCreated({
                    retry: { attempts: 3 },
                    async handler(_ctx, event) {
                      attempts++
                      if (attempts < 3) throw new Error('retry me')
                      handled.push(event)
                    },
                  }),
                },
                {
                  groupId: createTestName('events-redis-retry-group'),
                  from: 'earliest',
                },
              ),
            ],
          })

          await adapter.produce({
            topic,
            name: stream.events.userCreated.event,
            key: 'user-1',
            payload: { id: 'user-1' },
            headers: {},
          })

          await waitFor(() => handled.length === 1)
          expect(attempts).toBe(3)
          expect(handled).toEqual([
            {
              namespace: topic,
              event: 'userCreated',
              key: 'user-1',
              payload: { id: 'user-1' },
              headers: {},
            },
          ])
        } finally {
          await runner.dispose()
        }
      })
    },
  )
}

async function expectPendingCount(
  client: RedisStreamsEventingClient,
  stream: string,
  group: string,
  count: number,
) {
  await waitFor(async () => {
    const pending = (await client.xpending(stream, group)) as [number]
    return pending[0] === count
  })
}

function chunkPairs(values: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < values.length; index += 2) {
    pairs.push([values[index]!, values[index + 1] ?? ''])
  }
  return pairs
}
