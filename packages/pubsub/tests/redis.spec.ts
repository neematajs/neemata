import EventEmitter from 'node:events'

import { describe, expect, it } from 'vitest'

import { RedisPubSubAdapter, type RedisPubSubClient } from '../src/redis.ts'

class TestRedisClient extends EventEmitter {
  public readonly duplicateClient: TestRedisClient
  public readonly subscribePayload: unknown
  public subscribeCalls = 0
  public unsubscribeCalls = 0

  constructor(duplicateClient?: TestRedisClient, subscribePayload?: unknown) {
    super()
    this.duplicateClient = duplicateClient ?? this
    this.subscribePayload = subscribePayload
  }

  duplicate() {
    return this.duplicateClient
  }

  async connect() {}

  async subscribe(channel: string) {
    this.subscribeCalls++
    this.emit('message', channel, JSON.stringify(this.subscribePayload))
  }

  async unsubscribe() {
    this.unsubscribeCalls++
  }

  async quit() {}

  async publish() {
    return 1
  }
}

describe('RedisPubSubAdapter', () => {
  it('does not drop messages delivered as the broker subscription becomes ready', async () => {
    const message = { event: 'message', payload: { text: 'hello' } }
    const subscriber = new TestRedisClient(undefined, message)
    const adapter = new RedisPubSubAdapter(
      new TestRedisClient(subscriber) as unknown as RedisPubSubClient,
    )
    await adapter.initialize()

    const iterator = adapter.subscribe('room').next()

    try {
      await expect(Promise.race([iterator, timeout(250)])).resolves.toEqual({
        done: false,
        value: { channel: 'room', data: message },
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('does not unsubscribe an active channel when another subscriber is already aborted', async () => {
    const subscriber = new TestRedisClient()
    const adapter = new RedisPubSubAdapter(
      new TestRedisClient(subscriber) as unknown as RedisPubSubClient,
    )
    await adapter.initialize()

    const active = adapter.subscribe('room').next()
    await waitFor(() => subscriber.subscribeCalls === 1)

    const controller = new AbortController()
    controller.abort()
    await expect(
      adapter.subscribe('room', controller.signal).next(),
    ).resolves.toEqual({ done: true, value: undefined })

    expect(subscriber.unsubscribeCalls).toBe(0)

    await adapter.dispose()
    await active
  })
})

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('message not delivered')), ms)
  })
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 250
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition not met')
}
