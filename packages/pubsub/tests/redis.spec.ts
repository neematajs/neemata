import EventEmitter from 'node:events'

import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { PubSubLogger } from '../src/utils.ts'
import { defineChannel } from '../src/contract.ts'
import { PubSubManager } from '../src/manager.ts'
import { RedisPubSubAdapter, type RedisPubSubClient } from '../src/redis.ts'

// Mirrors a Redis subscriber connection: commands fail once it has quit.
class TestSubscriber extends EventEmitter {
  public readonly subscribed = new Set<string>()
  public subscribeCalls = 0
  public unsubscribeCalls = 0
  public closed = false
  public onSubscribe?: (channel: string) => unknown
  public onUnsubscribe?: (channel: string) => unknown

  async connect() {}

  async subscribe(channel: string) {
    this.assertOpen()
    this.subscribeCalls++
    await this.onSubscribe?.(channel)
    this.subscribed.add(channel)
  }

  async unsubscribe(channel: string) {
    this.assertOpen()
    this.unsubscribeCalls++
    await this.onUnsubscribe?.(channel)
    this.subscribed.delete(channel)
  }

  async quit() {
    this.closed = true
    this.subscribed.clear()
  }

  private assertOpen() {
    if (this.closed) throw new Error('Connection is closed.')
  }
}

class TestClient {
  constructor(readonly subscriber = new TestSubscriber()) {}

  duplicate() {
    return this.subscriber
  }

  async publish(channel: string, message: string) {
    if (this.subscriber.subscribed.has(channel))
      this.subscriber.emit('message', channel, message)
    return 1
  }
}

const message = { event: 'ping', payload: 1 }

async function setup(logger?: PubSubLogger) {
  const client = new TestClient()
  const adapter = new RedisPubSubAdapter(
    client as unknown as RedisPubSubClient,
    logger,
  )
  await adapter.initialize()
  return { adapter, client, subscriber: client.subscriber }
}

async function open(adapter: RedisPubSubAdapter, signal?: AbortSignal) {
  return (await adapter.subscribe('room', signal))[Symbol.asyncIterator]()
}

describe('RedisPubSubAdapter', () => {
  it('does not drop messages delivered as the broker subscription becomes ready', async () => {
    const { adapter, subscriber } = await setup()
    subscriber.onSubscribe = (channel) =>
      subscriber.emit('message', channel, JSON.stringify(message))

    const messages = await open(adapter)

    try {
      await expect(
        Promise.race([messages.next(), timeout(250)]),
      ).resolves.toEqual({
        done: false,
        value: { channel: 'room', data: message },
      })
    } finally {
      await adapter.dispose()
    }
  })

  it('does not unsubscribe an active channel when another subscriber is already aborted', async () => {
    const { adapter, subscriber } = await setup()
    await open(adapter)

    const controller = new AbortController()
    controller.abort()
    await expect(
      adapter.subscribe('room', controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(subscriber.unsubscribeCalls).toBe(0)
    expect(subscriber.subscribed.has('room')).toBe(true)

    await adapter.dispose()
  })

  it('resolves only once the broker subscription is live', async () => {
    const { adapter, client, subscriber } = await setup()
    const manager = new PubSubManager({ adapter })
    const channel = defineChannel({
      name: 'room',
      events: { ping: z.number() },
    })

    const stream = await manager.subscribe(channel, undefined)
    expect(subscriber.subscribed.has('room')).toBe(true)

    await client.publish('room', JSON.stringify(message))
    const messages = stream[Symbol.asyncIterator]()
    await expect(
      Promise.race([messages.next(), timeout(250)]),
    ).resolves.toEqual({ done: false, value: message })

    await messages.return?.()
    await adapter.dispose()
  })

  it('releases a subscription aborted before its messages are read', async () => {
    const { adapter, subscriber } = await setup()
    const controller = new AbortController()
    await open(adapter, controller.signal)

    controller.abort()

    await waitFor(() => subscriber.unsubscribeCalls === 1)
    expect(subscriber.subscribed.has('room')).toBe(false)
    await adapter.dispose()
  })

  it('resubscribes for a listener that arrives while the last one unsubscribes', async () => {
    const { adapter, client, subscriber } = await setup()
    const first = new AbortController()
    await open(adapter, first.signal)

    const unsubscribing = Promise.withResolvers<void>()
    subscriber.onUnsubscribe = () => unsubscribing.promise
    first.abort()
    await waitFor(() => subscriber.unsubscribeCalls === 1)

    const second = open(adapter)
    unsubscribing.resolve()
    const messages = await second

    expect(subscriber.subscribed.has('room')).toBe(true)
    await client.publish('room', JSON.stringify(message))
    await expect(
      Promise.race([messages.next(), timeout(250)]),
    ).resolves.toEqual({
      done: false,
      value: { channel: 'room', data: message },
    })

    await adapter.dispose()
  })

  it('retries SUBSCRIBE for each subscriber after one fails', async () => {
    const { adapter, client, subscriber } = await setup()
    let failures = 1
    subscriber.onSubscribe = () => {
      if (failures-- > 0) throw new Error('subscribe failed')
    }

    const [failed, succeeded] = await Promise.allSettled([
      open(adapter),
      open(adapter),
    ])

    expect(failed).toMatchObject({
      status: 'rejected',
      reason: new Error('subscribe failed'),
    })
    expect(succeeded.status).toBe('fulfilled')
    expect(subscriber.subscribeCalls).toBe(2)
    // The failed subscriber's local listener is detached, not leaked.
    expect(adapter['events'].listenerCount('room')).toBe(1)

    const messages = (succeeded as PromiseFulfilledResult<AsyncIterator<any>>)
      .value
    await client.publish('room', JSON.stringify(message))
    await expect(
      Promise.race([messages.next(), timeout(250)]),
    ).resolves.toEqual({
      done: false,
      value: { channel: 'room', data: message },
    })

    await adapter.dispose()
  })

  it('ends live subscriptions cleanly when disposed', async () => {
    const logged: unknown[] = []
    const logger: PubSubLogger = {
      trace() {},
      debug() {},
      warn: (_obj, msg) => logged.push(msg),
      error: (_obj, msg) => logged.push(msg),
    }
    const { adapter, client, subscriber } = await setup(logger)
    const manager = new PubSubManager({ adapter, logger })
    const channel = defineChannel({
      name: 'room',
      events: { ping: z.number() },
    })

    const stream = await manager.subscribe(channel, undefined)
    const received: unknown[] = []
    const consumed = (async () => {
      for await (const item of stream) received.push(item)
    })()
    await client.publish('room', JSON.stringify(message))
    await waitFor(() => received.length === 1)

    await adapter.dispose()

    await expect(consumed).resolves.toBeUndefined()
    expect(received).toEqual([message])
    expect(subscriber.unsubscribeCalls).toBe(0)
    expect(logged).toEqual([])
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
