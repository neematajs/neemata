import {
  PubSubChannelContract,
  PubSubEventContract,
  PubSubManager,
  RedisPubSubAdapter,
} from '@nmtjs/pubsub'
import { t } from '@nmtjs/type'
import { Redis } from 'ioredis'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createTestLogger,
  createTestName,
  redisUrl,
  waitFor,
} from './helpers.ts'

describe.skipIf(!redisUrl)('@nmtjs/pubsub Redis e2e', () => {
  const clients: Redis[] = []
  const adapters: RedisPubSubAdapter[] = []

  afterEach(async () => {
    await Promise.allSettled(
      adapters.splice(0).map((adapter) => adapter.dispose()),
    )
    await Promise.allSettled(clients.splice(0).map((client) => client.quit()))
  })

  it('publishes typed events to all Redis subscribers', async () => {
    const channelName = createTestName('pubsub')
    const channel = PubSubChannelContract({
      name: channelName,
      params: t.object({ id: t.string() }),
      events: {
        message: PubSubEventContract({
          payload: t.object({ text: t.string() }),
        }),
      },
      channel: ({ id }) => `${channelName}:${id}`,
    })

    const clientA = createRedisClient()
    const clientB = createRedisClient()
    const adapterA = new RedisPubSubAdapter(
      clientA,
      createTestLogger('pubsub-a'),
    )
    const adapterB = new RedisPubSubAdapter(
      clientB,
      createTestLogger('pubsub-b'),
    )
    clients.push(clientA, clientB)
    adapters.push(adapterA, adapterB)
    await Promise.all([adapterA.initialize(), adapterB.initialize()])

    const managerA = new PubSubManager({
      logger: createTestLogger('pubsub-a'),
      adapter: adapterA,
    })
    const managerB = new PubSubManager({
      logger: createTestLogger('pubsub-b'),
      adapter: adapterB,
    })
    const abortA = new AbortController()
    const abortB = new AbortController()
    const [streamA, streamB] = await Promise.all([
      managerA.subscribe(channel, { id: 'room-1' }, undefined, abortA.signal),
      managerB.subscribe(channel, { id: 'room-1' }, undefined, abortB.signal),
    ])
    const received: unknown[] = []
    void collectOne(streamA, received, abortA)
    void collectOne(streamB, received, abortB)

    await waitFor(async () =>
      clientA.pubsub('NUMSUB', `${channelName}:room-1`).then((result) => {
        const count = Number(result[1] ?? 0)
        return count >= 2
      }),
    )

    await managerA.publish(
      channel.events.message,
      { id: 'room-1' },
      { text: 'hello' },
    )

    await waitFor(() => received.length === 2)
    expect(received).toEqual([
      { event: `${channelName}/message`, data: { text: 'hello' } },
      { event: `${channelName}/message`, data: { text: 'hello' } },
    ])
  })

  it('filters selected events and unsubscribes from Redis channels', async () => {
    const channelName = createTestName('pubsub-filter')
    const channel = PubSubChannelContract({
      name: channelName,
      params: t.object({ id: t.string() }),
      events: {
        message: PubSubEventContract({
          payload: t.object({ text: t.string() }),
        }),
        typing: PubSubEventContract({
          payload: t.object({ userId: t.string() }),
        }),
      },
      channel: ({ id }) => `${channelName}:${id}`,
    })

    const client = createRedisClient()
    const adapter = new RedisPubSubAdapter(
      client,
      createTestLogger('pubsub-filter'),
    )
    clients.push(client)
    adapters.push(adapter)
    await adapter.initialize()

    const manager = new PubSubManager({
      logger: createTestLogger('pubsub-filter'),
      adapter,
    })
    const controller = new AbortController()
    const stream = await manager.subscribe(
      channel,
      { id: 'room-1' },
      { message: true },
      controller.signal,
    )
    const received: unknown[] = []
    const collector = collectUntil(stream, received, controller, 1)

    await waitFor(async () =>
      hasSubscribers(client, `${channelName}:room-1`, 1),
    )

    await manager.publish(
      channel.events.typing,
      { id: 'room-1' },
      { userId: 'u1' },
    )
    await manager.publish(
      channel.events.message,
      { id: 'room-1' },
      { text: 'visible' },
    )

    await collector
    expect(received).toEqual([
      { event: `${channelName}/message`, data: { text: 'visible' } },
    ])

    await waitFor(async () =>
      hasSubscribers(client, `${channelName}:room-1`, 0),
    )
    await manager.publish(
      channel.events.message,
      { id: 'room-1' },
      { text: 'late' },
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(received).toHaveLength(1)
  })
})

function createRedisClient() {
  return new Redis(redisUrl!, { maxRetriesPerRequest: null })
}

async function collectOne(
  stream: AsyncIterable<unknown>,
  received: unknown[],
  controller: AbortController,
) {
  for await (const message of stream) {
    received.push(message)
    controller.abort()
    return
  }
}

async function collectUntil(
  stream: AsyncIterable<unknown>,
  received: unknown[],
  controller: AbortController,
  count: number,
) {
  for await (const message of stream) {
    received.push(message)
    if (received.length >= count) {
      controller.abort()
      return
    }
  }
}

async function hasSubscribers(
  client: Redis,
  channel: string,
  expected: number,
) {
  const result = await client.pubsub('NUMSUB', channel)
  return Number(result[1] ?? 0) === expected
}
