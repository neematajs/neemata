import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { PubSubManager } from '@nmtjs/pubsub'
import { RedisPubSubAdapter } from '@nmtjs/pubsub/redis'
import { afterEach, describe, expect, it } from 'vitest'

import type { RedisPubSubClient } from '../../src/redis.ts'
import { t } from '../../../type/src/index.ts'
import {
  createTestLogger,
  createTestName,
  requireServiceEnv,
  serviceTargets,
  waitFor,
} from './helpers.ts'

for (const target of serviceTargets) {
  requireServiceEnv(target)

  describe.skipIf(!target.url)(
    `@nmtjs/pubsub ${target.name} integration`,
    () => {
      const clients: RedisPubSubClient[] = []
      const adapters: RedisPubSubAdapter[] = []

      afterEach(async () => {
        await Promise.allSettled(
          adapters.splice(0).map((adapter) => adapter.dispose()),
        )
        await Promise.allSettled(
          clients.splice(0).map((client) => client.quit()),
        )
      })

      it('publishes typed events to all subscribers', async () => {
        const channelName = createTestName('pubsub')
        const channel = SubscriptionContract({
          namespace: channelName,
          params: t.object({ id: t.string() }),
          events: {
            message: EventContract({ payload: t.object({ text: t.string() }) }),
          },
          key: ({ id }) => id,
        })

        const clientA = target.createClient()
        const clientB = target.createClient()
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
          managerA.subscribe(
            channel,
            { id: 'room-1' },
            undefined,
            abortA.signal,
          ),
          managerB.subscribe(
            channel,
            { id: 'room-1' },
            undefined,
            abortB.signal,
          ),
        ])
        const received: unknown[] = []
        void collectOne(streamA, received, abortA)
        void collectOne(streamB, received, abortB)

        await waitFor(async () =>
          hasSubscribers(clientA, `${channelName}:room-1`, 2),
        )

        await managerA.publish(
          channel.events.message,
          { id: 'room-1' },
          { text: 'hello' },
        )

        await waitFor(() => received.length === 2)
        expect(received).toEqual([
          { event: 'message', payload: { text: 'hello' } },
          { event: 'message', payload: { text: 'hello' } },
        ])
      })

      it('filters selected events and unsubscribes from channels', async () => {
        const channelName = createTestName('pubsub-filter')
        const channel = SubscriptionContract({
          namespace: channelName,
          params: t.object({ id: t.string() }),
          events: {
            message: EventContract({ payload: t.object({ text: t.string() }) }),
            typing: EventContract({
              payload: t.object({ userId: t.string() }),
            }),
          },
          key: ({ id }) => id,
        })

        const client = target.createClient()
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
          { event: 'message', payload: { text: 'visible' } },
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

      it('skips unknown and invalid broker messages before delivering valid events', async () => {
        const channelName = createTestName('pubsub-noise')
        const channel = SubscriptionContract({
          namespace: channelName,
          params: t.object({ id: t.string() }),
          events: {
            message: EventContract({ payload: t.object({ text: t.string() }) }),
          },
          key: ({ id }) => id,
        })

        const client = target.createClient()
        const adapter = new RedisPubSubAdapter(
          client,
          createTestLogger('pubsub-noise'),
        )
        clients.push(client)
        adapters.push(adapter)
        await adapter.initialize()

        const manager = new PubSubManager({
          logger: createTestLogger('pubsub-noise'),
          adapter,
        })
        const controller = new AbortController()
        const stream = await manager.subscribe(
          channel,
          { id: 'room-1' },
          undefined,
          controller.signal,
        )
        const received: unknown[] = []
        const collector = collectUntil(stream, received, controller, 1)
        const rawChannel = `${channelName}:room-1`

        await waitFor(async () => hasSubscribers(client, rawChannel, 1))
        await client.publish(
          rawChannel,
          JSON.stringify({ event: 'missing', payload: { text: 'ignored' } }),
        )
        await client.publish(
          rawChannel,
          JSON.stringify({ event: 'message', payload: { text: 123 } }),
        )
        await manager.publish(
          channel.events.message,
          { id: 'room-1' },
          { text: 'visible' },
        )

        await collector
        expect(received).toEqual([
          { event: 'message', payload: { text: 'visible' } },
        ])
      })
    },
  )
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
  client: RedisPubSubClient,
  channel: string,
  expected: number,
) {
  const result = await client.pubsub('NUMSUB', channel)
  return Number(result[1] ?? 0) === expected
}
