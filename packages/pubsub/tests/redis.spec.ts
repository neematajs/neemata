import EventEmitter from 'node:events'

import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { PubSubLogger } from '../src/utils.ts'
import { defineChannel } from '../src/contract.ts'
import { PubSubManager } from '../src/manager.ts'
import { RedisPubSubAdapter, type RedisPubSubClient } from '../src/redis.ts'
import { PubSubConnectionLostError } from '../src/utils.ts'

// Mirrors a Redis subscriber connection with the offline queue disabled:
// commands fail unless the connection is ready, and one in flight when the
// connection drops never settles, as the driver does not resend it.
class TestSubscriber extends EventEmitter {
  public readonly subscribed = new Set<string>()
  public subscribeCalls = 0
  public unsubscribeCalls = 0
  public status = 'wait'
  public onSubscribe?: (channel: string) => unknown
  public onUnsubscribe?: (channel: string) => unknown

  async connect() {
    this.status = 'ready'
  }

  async subscribe(channel: string) {
    const connection = this.assertReady()
    this.subscribeCalls++
    await this.inFlight(connection, this.onSubscribe?.(channel))
    this.subscribed.add(channel)
  }

  async unsubscribe(channel: string) {
    const connection = this.assertReady()
    this.unsubscribeCalls++
    await this.inFlight(connection, this.onUnsubscribe?.(channel))
    this.subscribed.delete(channel)
  }

  /** Drops the connection, or fails a reconnect attempt, and retries. */
  drop() {
    this.connection++
    this.subscribed.clear()
    this.status = 'reconnecting'
    process.nextTick(() => this.emit('close'))
  }

  reconnect() {
    this.status = 'ready'
    process.nextTick(() => this.emit('ready'))
  }

  disconnect() {
    // Stopped while waiting to reconnect, the driver emits nothing more.
    if (this.status !== 'ready') return
    this.drop()
    this.status = 'end'
    process.nextTick(() => this.emit('end'))
  }

  private connection = 0

  private async inFlight(connection: number, reply: unknown) {
    await reply
    if (connection !== this.connection) await new Promise(() => {})
  }

  private assertReady() {
    if (this.status !== 'ready')
      throw new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      )
    return this.connection
  }
}

class TestClient {
  constructor(readonly subscriber = new TestSubscriber()) {}

  duplicate() {
    return this.subscriber
  }

  async publish(channel: string, message: string) {
    if (
      this.subscriber.status === 'ready' &&
      this.subscriber.subscribed.has(channel)
    )
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

  describe('when the subscriber connection drops', () => {
    it('ends established subscriptions with PubSubConnectionLostError', async () => {
      const { adapter, subscriber } = await setup()
      const manager = new PubSubManager({ adapter })
      const channel = defineChannel({
        name: 'room',
        events: { ping: z.number() },
      })
      const raw = await open(adapter)
      const stream = await manager.subscribe(channel, undefined)
      const consumed = (async () => {
        for await (const _ of stream);
      })()

      subscriber.drop()

      await expect(raw.next()).rejects.toBeInstanceOf(PubSubConnectionLostError)
      await expect(consumed).rejects.toBeInstanceOf(PubSubConnectionLostError)
      await waitFor(() => adapter['channels'].size === 0)
      expect(subscriber.unsubscribeCalls).toBe(0)

      await adapter.dispose()
    })

    it('ends a subscription whose messages are not being read', async () => {
      const { adapter, subscriber } = await setup()
      const messages = await open(adapter)

      subscriber.drop()
      await waitFor(() => adapter['channels'].size === 0)

      await expect(messages.next()).rejects.toBeInstanceOf(
        PubSubConnectionLostError,
      )
      await adapter.dispose()
    })

    it('ends before delivering a backlog the subscriber has not read', async () => {
      const { adapter, client, subscriber } = await setup()
      const messages = await open(adapter)
      for (let i = 0; i < 50; i++)
        await client.publish('room', JSON.stringify(message))

      subscriber.drop()
      await waitFor(() => adapter['channels'].size === 0)

      await expect(messages.next()).rejects.toBeInstanceOf(
        PubSubConnectionLostError,
      )
      await adapter.dispose()
    })

    it('ends a slow manager subscription before most of its backlog', async () => {
      const { adapter, client, subscriber } = await setup()
      const manager = new PubSubManager({ adapter })
      const channel = defineChannel({
        name: 'room',
        events: { ping: z.number() },
      })
      const stream = await manager.subscribe(channel, undefined)
      const messages = stream[Symbol.asyncIterator]()
      for (let i = 0; i < 50; i++)
        await client.publish('room', JSON.stringify(message))
      // The stream reads ahead of its consumer up to its own buffer.
      await messages.next()

      subscriber.drop()
      await waitFor(() => adapter['channels'].size === 0)

      let delivered = 0
      await expect(
        (async () => {
          while (!(await messages.next()).done) delivered++
        })(),
      ).rejects.toBeInstanceOf(PubSubConnectionLostError)
      // The stream learns of the loss on its next pull from the adapter,
      // which its consumer's next read triggers.
      expect(delivered).toBeLessThanOrEqual(2)
      await adapter.dispose()
    })

    it('subscribes a channel again for a listener that arrives after the reconnect', async () => {
      const { adapter, client, subscriber } = await setup()
      const lost = await open(adapter)
      subscriber.drop()
      await expect(lost.next()).rejects.toBeInstanceOf(
        PubSubConnectionLostError,
      )

      subscriber.reconnect()
      const messages = await open(adapter)

      expect(subscriber.subscribeCalls).toBe(2)
      await client.publish('room', JSON.stringify(message))
      await expect(
        Promise.race([messages.next(), timeout(250)]),
      ).resolves.toEqual({
        done: false,
        value: { channel: 'room', data: message },
      })

      await adapter.dispose()
    })

    it('opens a subscription requested during an outage once the connection is back', async () => {
      const { adapter, client, subscriber } = await setup()
      subscriber.drop()

      const opening = open(adapter)
      // Failed reconnect attempts close the connection again.
      subscriber.drop()
      subscriber.drop()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(subscriber.subscribeCalls).toBe(0)

      subscriber.reconnect()
      const messages = await opening

      expect(subscriber.subscribeCalls).toBe(1)
      await client.publish('room', JSON.stringify(message))
      await expect(
        Promise.race([messages.next(), timeout(250)]),
      ).resolves.toEqual({
        done: false,
        value: { channel: 'room', data: message },
      })

      await adapter.dispose()
    })

    it('rejects an opening subscription whose SUBSCRIBE was in flight', async () => {
      const { adapter, subscriber } = await setup()
      const subscribing = Promise.withResolvers<void>()
      subscriber.onSubscribe = () => subscribing.promise

      const opening = open(adapter)
      await waitFor(() => subscriber.subscribeCalls === 1)
      subscriber.drop()

      await expect(opening).rejects.toBeInstanceOf(PubSubConnectionLostError)
      // The reply never arrives, yet the channel converges.
      await waitFor(() => adapter['channels'].size === 0)

      await adapter.dispose()
    })

    it('stops waiting for the connection when an opening subscription is aborted', async () => {
      const { adapter, subscriber } = await setup()
      subscriber.drop()
      const controller = new AbortController()

      const opening = open(adapter, controller.signal)
      controller.abort()

      await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
      subscriber.reconnect()
      await waitFor(() => adapter['channels'].size === 0)
      expect(subscriber.subscribeCalls).toBe(0)

      await adapter.dispose()
    })

    it('drains subscriptions aborted while waiting for the connection', async () => {
      const { adapter, subscriber } = await setup()
      subscriber.drop()
      await new Promise((resolve) => process.nextTick(resolve))

      for (const channel of Array.from({ length: 12 }, (_, i) => `room-${i}`)) {
        for (let attempt = 0; attempt < 2; attempt++) {
          const controller = new AbortController()
          const opening = adapter.subscribe(channel, controller.signal)
          await waitFor(() => adapter['statusWaiters'].size === 1)
          controller.abort()
          await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
        }
      }

      await waitFor(() => adapter['channels'].size === 0)
      expect(adapter['statusWaiters'].size).toBe(0)
      subscriber.reconnect()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(subscriber.subscribeCalls).toBe(0)

      await adapter.dispose()
    })

    it('queues nothing for joins aborted while another listener waits for the connection', async () => {
      const { adapter, client, subscriber } = await setup()
      subscriber.drop()
      await new Promise((resolve) => process.nextTick(resolve))
      const waiting = open(adapter)

      for (let attempt = 0; attempt < 100; attempt++) {
        const controller = new AbortController()
        const opening = open(adapter, controller.signal)
        await new Promise((resolve) => setTimeout(resolve, 0))
        controller.abort()
        await expect(opening).rejects.toMatchObject({ name: 'AbortError' })
      }

      // Releases share one queued reconcile behind the one that waits to
      // subscribe on the remaining listener's behalf, however many joins left.
      const state = adapter['channels'].get('room')!
      expect(state.listeners).toBe(1)
      expect(state.queue.pending).toBeLessThanOrEqual(2)
      expect(adapter['statusWaiters'].size).toBeLessThanOrEqual(2)

      subscriber.reconnect()
      const messages = await waiting
      expect(subscriber.subscribeCalls).toBe(1)
      await client.publish('room', JSON.stringify(message))
      await expect(
        Promise.race([messages.next(), timeout(250)]),
      ).resolves.toEqual({
        done: false,
        value: { channel: 'room', data: message },
      })

      await adapter.dispose()
    })

    it('releases without UNSUBSCRIBE before the drop is reported', async () => {
      const { adapter, subscriber } = await setup()
      const controller = new AbortController()
      const messages = await open(adapter, controller.signal)

      // The driver changes status before it emits `close`.
      subscriber.status = 'reconnecting'
      controller.abort()

      await expect(messages.next()).resolves.toEqual({
        done: true,
        value: undefined,
      })
      await waitFor(() => adapter['channels'].size === 0)
      expect(subscriber.unsubscribeCalls).toBe(0)

      await adapter.dispose()
    })

    it('leaves the iteration without waiting for a SUBSCRIBE held back by the outage', async () => {
      const { adapter, client, subscriber } = await setup()
      const messages = await open(adapter)
      // Suspends the generator at its yield, so return() runs its release.
      await client.publish('room', JSON.stringify(message))
      await messages.next()
      // A listener joining a channel no longer subscribed on a connection
      // that is down queues its SUBSCRIBE ahead of the release.
      subscriber.status = 'reconnecting'
      const state = adapter['channels'].get('room')!
      state.subscribed = false
      const opening = open(adapter)
      await waitFor(() => state.listeners === 2)

      await expect(
        Promise.race([messages.return!(), timeout(250)]),
      ).resolves.toEqual({ done: true, value: undefined })
      expect(state.listeners).toBe(1)

      subscriber.reconnect()
      await opening
      await adapter.dispose()
    })

    it('disposes without waiting for the connection', async () => {
      const logged: unknown[] = []
      const logger: PubSubLogger = {
        trace() {},
        debug() {},
        warn: (_obj, msg) => logged.push(msg),
        error: (_obj, msg) => logged.push(msg),
      }
      const { adapter, subscriber } = await setup(logger)
      subscriber.onSubscribe = (channel) =>
        channel === 'lobby' ? new Promise(() => {}) : undefined
      const inFlight = adapter.subscribe('lobby')
      await waitFor(() => subscriber.subscribeCalls === 1)
      subscriber.status = 'reconnecting'
      const waiting = open(adapter)

      await expect(
        Promise.race([adapter.dispose(), timeout(250)]),
      ).resolves.toBeUndefined()

      await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' })
      await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
      expect(logged).toEqual([])
    })
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
