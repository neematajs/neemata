import { EventStreamContract } from '@nmtjs/eventing'
import { RedisStreamsEventingAdapter } from '@nmtjs/eventing/redis-streams'
import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createTestLogger,
  createTestName,
  redisUrl,
  waitFor,
} from './helpers.ts'

describe.skipIf(!redisUrl)('@nmtjs/eventing Redis Streams e2e', () => {
  const clients: Redis[] = []
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
    await Promise.allSettled(clients.splice(0).map((client) => client.quit()))
  })

  it('recovers pending messages and dead-letters poison messages', async () => {
    const topic = createTestName('events-redis')
    const dlq = `${topic}.dlq`
    streams.add(topic)
    streams.add(dlq)
    const groupId = createTestName('group')
    const consumerId = 'consumer-1'
    const event = EventStreamContract({
      name: 'user.created',
      topic,
      key: t.string(),
      payload: t.object({ id: t.string() }),
    })
    const client = createRedisClient()
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
      name: event.name,
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
      name: event.name,
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
    expect(Object.fromEntries(chunkPairs(dlqMessages[0]![1]))).toMatchObject({
      sourceTopic: topic,
      name: event.name,
      key: 'user-2',
    })
  })
})

function createRedisClient() {
  return new Redis(redisUrl!, { maxRetriesPerRequest: null })
}

async function expectPendingCount(
  client: Redis,
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
