import EventEmitter from 'node:events'
import { Writable } from 'node:stream'

import type {
  PubSubAdapter,
  PubSubMessage,
  RedisPubSubClient,
} from '@nmtjs/pubsub'
import { Container, createLogger } from '@nmtjs/core'
import {
  createPubSubPlugin,
  PubSubChannelContract,
  PubSubEventContract,
  PubSubManager,
  pubsubAdapter,
  RedisPubSubAdapter,
} from '@nmtjs/pubsub'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

type CapturedLog = Record<string, any>

class TestPubSubAdapter implements PubSubAdapter {
  publishResult = true
  publishError?: Error
  publishCalls: Array<{ channel: string; payload: unknown }> = []
  subscribeCalls: string[] = []
  initializeCalls = 0
  disposeCalls = 0

  async initialize() {
    this.initializeCalls++
  }

  async dispose() {
    this.disposeCalls++
  }

  async publish(channel: string, payload: unknown): Promise<boolean> {
    this.publishCalls.push({ channel, payload })
    if (this.publishError) throw this.publishError
    return this.publishResult
  }

  async *subscribe(channel: string): AsyncGenerator<PubSubMessage> {
    this.subscribeCalls.push(channel)
    yield {
      channel,
      payload: { event: 'chat.room/message', data: { text: 'hello' } },
    }
  }
}

class FakeRedisClient extends EventEmitter {
  duplicateClient?: FakeRedisClient
  publishError?: Error
  subscribed: string[] = []
  unsubscribed: string[] = []
  published: Array<{ channel: string; payload: string }> = []
  quitCalls = 0

  duplicate() {
    return this.duplicateClient ?? this
  }

  async subscribe(channel: string) {
    this.subscribed.push(channel)
  }

  async unsubscribe(channel: string) {
    this.unsubscribed.push(channel)
  }

  async publish(channel: string, payload: string) {
    if (this.publishError) throw this.publishError
    this.published.push({ channel, payload })
  }

  async quit() {
    this.quitCalls++
  }
}

const chatChannel = 'chat:room-1'
const chatRoom = PubSubChannelContract({
  name: 'chat.room',
  params: t.object({ roomId: t.string() }),
  events: {
    message: PubSubEventContract({ payload: t.object({ text: t.string() }) }),
    typing: PubSubEventContract({ payload: t.object({ userId: t.string() }) }),
  },
  channel: (params) => `chat:${params.roomId}`,
})

describe('@nmtjs/pubsub contracts', () => {
  it('provides publish/subscribe through an application plugin', async () => {
    const adapter = new TestPubSubAdapter()
    const { logger } = createCapturingLogger('pubsub-plugin-test')
    const container = new Container({ logger })
    const plugin = createPubSubPlugin({ adapter: () => adapter })

    await plugin.hooks?.['lifecycle:beforeInitialize']?.({ logger, container })

    const manager = new PubSubManager({ logger, adapter })
    const stream = await manager.subscribe(chatRoom, { roomId: 'room-1' })

    const events: unknown[] = []
    for await (const event of stream) events.push(event)

    await plugin.hooks?.['lifecycle:beforeDispose']?.({ logger, container })

    expect(events).toEqual([
      { event: 'chat.room/message', data: { text: 'hello' } },
    ])
    expect(adapter.initializeCalls).toBe(1)
    expect(adapter.disposeCalls).toBe(1)
    expect(container.contains(pubsubAdapter)).toBe(true)
  })

  it('logs manager channel lifecycle and publish failures', async () => {
    const adapter = new TestPubSubAdapter()
    const { manager, getLogs } = createPubSubManagerHarness(adapter)

    const stream = await manager.subscribe(chatRoom, { roomId: 'room-1' })

    const events: unknown[] = []
    for await (const event of stream) {
      expectTypeOf(event).toEqualTypeOf<
        | { event: 'chat.room/message'; data: { text: string } }
        | { event: 'chat.room/typing'; data: { userId: string } }
      >()
      events.push(event)
    }

    adapter.publishResult = false
    const published = await manager.publish(
      chatRoom.events.message,
      { roomId: 'room-1' },
      { text: 'world' },
    )

    await waitForLogs()
    const logs = getLogs()

    expect(events).toEqual([
      { event: 'chat.room/message', data: { text: 'hello' } },
    ])
    expect(published).toBe(false)
    expect(
      logs.find((entry) => entry.msg === 'Opening pubsub channel'),
    ).toMatchObject({ component: 'PubSubManager', channel: chatChannel })
    expect(
      logs.find(
        (entry) => entry.msg === 'Pubsub adapter reported publish failure',
      ),
    ).toMatchObject({ component: 'PubSubManager', channel: chatChannel })
  })

  it('publishes explicit channels through the adapter contract', async () => {
    const adapter = new TestPubSubAdapter()
    const { manager } = createPubSubManagerHarness(adapter)

    await expect(
      manager.publish(
        chatRoom.events.message,
        { roomId: 'room-1' },
        { text: 'world' },
      ),
    ).resolves.toBe(true)

    expect(adapter.publishCalls).toEqual([
      {
        channel: chatChannel,
        payload: { event: 'chat.room/message', data: { text: 'world' } },
      },
    ])
  })

  it('keeps Redis adapter client-owned and logs malformed messages', async () => {
    const { logger, getLogs } = createCapturingLogger('redis-subscription-test')
    const client = new FakeRedisClient()
    const subscriber = new FakeRedisClient()
    client.duplicateClient = subscriber

    const adapter = new RedisPubSubAdapter(
      client as unknown as RedisPubSubClient,
      logger,
    )

    await adapter.initialize()

    const iterator = adapter.subscribe('chat/channel')
    const nextMessage = iterator.next()

    await waitForLogs()
    subscriber.emit('message', 'chat/channel', '{bad json')
    subscriber.emit(
      'message',
      'chat/channel',
      JSON.stringify({ text: 'payload' }),
    )

    await expect(nextMessage).resolves.toEqual({
      done: false,
      value: { channel: 'chat/channel', payload: { text: 'payload' } },
    })

    client.publishError = new Error('publish failed')
    await expect(
      adapter.publish('chat/channel', { text: 'outbound' }),
    ).resolves.toBe(false)

    await iterator.return(undefined)
    await adapter.dispose()
    await waitForLogs()

    const logs = getLogs()

    expect(
      logs.find((entry) => entry.msg === 'Redis adapter initialized'),
    ).toMatchObject({ component: 'RedisPubSubAdapter' })
    expect(
      logs.find((entry) => entry.msg === 'Failed to parse Redis message'),
    ).toMatchObject({
      component: 'RedisPubSubAdapter',
      channel: 'chat/channel',
    })
    expect(subscriber.subscribed).toEqual(['chat/channel'])
    expect(subscriber.unsubscribed).toEqual(['chat/channel'])
    expect(subscriber.quitCalls).toBe(1)
  })
})

const waitForLogs = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function createCapturingLogger(label = 'test') {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })

  const logger = createLogger(
    {
      destinations: [{ level: 'trace', stream }],
      pinoOptions: { level: 'trace' },
    },
    label,
  )

  const getLogs = (): CapturedLog[] =>
    chunks.flatMap((chunk) =>
      chunk
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CapturedLog),
    )

  return { logger, getLogs }
}

function createPubSubManagerHarness(adapter: PubSubAdapter) {
  const { logger, getLogs } = createCapturingLogger('pubsub-test')
  return { manager: new PubSubManager({ logger, adapter }), getLogs }
}
