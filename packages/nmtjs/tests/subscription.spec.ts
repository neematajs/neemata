import EventEmitter from 'node:events'
import { Writable } from 'node:stream'

import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { Container, createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import type {
  SubscriptionAdapterEvent,
  SubscriptionAdapterType,
} from '../src/runtime/subscription/manager.ts'
import type { Store } from '../src/runtime/types.ts'
import { subscriptionAdapter } from '../src/runtime/injectables.ts'
import { SubscriptionManager } from '../src/runtime/subscription/manager.ts'
import { RedisSubscriptionAdapter } from '../src/runtime/subscription/redis.ts'

type CapturedLog = Record<string, any>

class TestSubscriptionAdapter implements SubscriptionAdapterType {
  publishResult = true
  publishError?: Error
  subscribeCalls: string[] = []

  async initialize() {}

  async dispose() {}

  async publish(): Promise<boolean> {
    if (this.publishError) {
      throw this.publishError
    }

    return this.publishResult
  }

  async *subscribe(channel: string): AsyncGenerator<SubscriptionAdapterEvent> {
    this.subscribeCalls.push(channel)
    yield { channel, payload: { text: 'hello' } }
  }
}

class FakeStore extends EventEmitter {
  duplicateClient?: FakeStore
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
    if (this.publishError) {
      throw this.publishError
    }

    this.published.push({ channel, payload })
  }

  async quit() {
    this.quitCalls++
  }
}

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

function createSubscriptionManagerHarness(adapter: SubscriptionAdapterType) {
  const { logger, getLogs } = createCapturingLogger('pubsub-test')
  const container = new Container({ logger })

  container.provide(subscriptionAdapter, adapter)

  return { manager: new SubscriptionManager({ logger, container }), getLogs }
}

const chatSubscription = SubscriptionContract.withOptions<{ roomId: string }>()(
  {
    name: 'chat',
    events: {
      message: EventContract({ payload: t.object({ text: t.string() }) }),
    },
  },
)

describe('Subscription logging', () => {
  it('logs manager subscription lifecycle and publish failures', async () => {
    const adapter = new TestSubscriptionAdapter()
    const { manager, getLogs } = createSubscriptionManagerHarness(adapter)

    const stream = await manager.subscribe(
      chatSubscription,
      { message: true },
      { roomId: 'room-1' },
    )

    const events: Array<{ event: string; data: { text: string } }> = []
    for await (const event of stream) {
      events.push(event as { event: string; data: { text: string } })
    }

    adapter.publishResult = false
    const published = await manager.publish(
      chatSubscription.events.message,
      { roomId: 'room-1' },
      { text: 'world' },
    )

    await waitForLogs()

    const logs = getLogs()

    expect(events).toEqual([{ event: 'chat/message', data: { text: 'hello' } }])
    expect(published).toBe(false)

    expect(
      logs.find((entry) => entry.msg === 'Opening subscription'),
    ).toMatchObject({
      component: 'SubscriptionManager',
      subscription: 'chat',
      eventCount: 1,
    })
    expect(
      logs.find((entry) => entry.msg === 'Creating channel stream'),
    ).toMatchObject({ component: 'SubscriptionManager', event: 'chat/message' })
    expect(logs.find((entry) => entry.msg === 'Received event')).toMatchObject({
      component: 'SubscriptionManager',
      event: 'chat/message',
    })
    expect(
      logs.find(
        (entry) => entry.msg === 'Pubsub adapter reported publish failure',
      ),
    ).toMatchObject({ component: 'SubscriptionManager', event: 'chat/message' })
  })

  it('logs Redis adapter lifecycle and malformed messages', async () => {
    const { logger, getLogs } = createCapturingLogger('redis-subscription-test')
    const client = new FakeStore()
    const subscriber = new FakeStore()
    client.duplicateClient = subscriber

    const adapter = new RedisSubscriptionAdapter(
      client as unknown as Store,
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
    ).toMatchObject({ component: 'RedisSubscriptionAdapter' })
    expect(
      logs.find((entry) => entry.msg === 'Subscribed Redis channel'),
    ).toMatchObject({
      component: 'RedisSubscriptionAdapter',
      channel: 'chat/channel',
      listeners: 1,
    })
    expect(
      logs.find((entry) => entry.msg === 'Failed to parse Redis message'),
    ).toMatchObject({
      component: 'RedisSubscriptionAdapter',
      channel: 'chat/channel',
    })
    expect(
      logs.find((entry) => entry.msg === 'Failed to publish Redis message'),
    ).toMatchObject({
      component: 'RedisSubscriptionAdapter',
      channel: 'chat/channel',
    })
    expect(
      logs.find((entry) => entry.msg === 'Unsubscribed Redis channel'),
    ).toMatchObject({
      component: 'RedisSubscriptionAdapter',
      channel: 'chat/channel',
      listeners: 0,
    })
    expect(
      logs.find((entry) => entry.msg === 'Redis adapter disposed'),
    ).toMatchObject({ component: 'RedisSubscriptionAdapter' })
    expect(subscriber.subscribed).toEqual(['chat/channel'])
    expect(subscriber.unsubscribed).toEqual(['chat/channel'])
    expect(subscriber.quitCalls).toBe(1)
  })
})
