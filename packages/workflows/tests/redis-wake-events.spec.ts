import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import type { WorkflowRedisClient } from '../src/adapters/redis.ts'
import { Keys } from '../src/adapters/redis/keys.ts'
import { WakeEvents } from '../src/adapters/redis/wake-events.ts'

type FakeSubscriber = EventEmitter & {
  status: string
  subscribe: ReturnType<typeof vi.fn>
  unsubscribe: ReturnType<typeof vi.fn>
  quit: ReturnType<typeof vi.fn>
}

const createHarness = () => {
  const subscriber = new EventEmitter() as FakeSubscriber
  subscriber.status = 'ready'
  subscriber.subscribe = vi.fn().mockResolvedValue(undefined)
  subscriber.unsubscribe = vi.fn().mockResolvedValue(undefined)
  subscriber.quit = vi.fn().mockResolvedValue(undefined)
  const keys = new Keys('nmtjs:test:wakes:')
  const events = new WakeEvents(
    { duplicate: () => subscriber } as unknown as WorkflowRedisClient,
    keys,
  )
  return { events, keys, subscriber }
}

const deferred = () => {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('Redis workflow wake events', () => {
  it('emits a catch-up hint when a run subscription becomes active', async () => {
    const { events, subscriber } = createHarness()
    const pendingSubscribe = deferred()
    subscriber.subscribe.mockReturnValueOnce(pendingSubscribe.promise)
    const listener = vi.fn()

    const remove = events.onRunEvent('run-1', listener)
    expect(listener).not.toHaveBeenCalled()

    pendingSubscribe.resolve()
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)

    remove()
    await settle()
    await events.dispose()
  })

  it('reasserts a run subscription and emits a catch-up hint after reconnect', async () => {
    const { events, subscriber } = createHarness()
    const listener = vi.fn()

    const remove = events.onRunEvent('run-1', listener)
    await settle()
    expect(listener).toHaveBeenCalledTimes(1)

    subscriber.emit('ready')
    await settle()
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledTimes(2)

    remove()
    await settle()
    await events.dispose()
  })

  it('keeps a re-added listener subscribed while the first subscribe is pending', async () => {
    const { events, keys, subscriber } = createHarness()
    const pendingSubscribe = deferred()
    subscriber.subscribe.mockReturnValueOnce(pendingSubscribe.promise)
    const firstListener = vi.fn()
    const secondListener = vi.fn()

    const removeFirst = events.onCommand('continue', firstListener)
    removeFirst()
    const removeSecond = events.onCommand('continue', secondListener)
    pendingSubscribe.resolve()
    await settle()

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1)
    expect(subscriber.unsubscribe).not.toHaveBeenCalled()
    subscriber.emit('message', keys.commandWake('continue'))
    expect(firstListener).not.toHaveBeenCalled()
    expect(secondListener).toHaveBeenCalledTimes(1)

    removeSecond()
    await settle()
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1)
    await events.dispose()
  })

  it('re-subscribes when a listener is added during a pending unsubscribe', async () => {
    const { events, subscriber } = createHarness()
    const pendingUnsubscribe = deferred()
    subscriber.unsubscribe.mockReturnValueOnce(pendingUnsubscribe.promise)
    const removeFirst = events.onCommand('continue', () => {})
    await settle()

    removeFirst()
    const removeSecond = events.onCommand('continue', () => {})
    pendingUnsubscribe.resolve()
    await settle()

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2)
    removeSecond()
    await settle()
    await events.dispose()
  })

  it('reasserts a re-added subscription after an ambiguous unsubscribe failure', async () => {
    const { events, subscriber } = createHarness()
    subscriber.unsubscribe.mockRejectedValueOnce(
      new Error('unsubscribe failed'),
    )
    const removeFirst = events.onCancellation('run-1', () => {})
    await settle()

    removeFirst()
    await settle()
    const removeSecond = events.onCancellation('run-1', () => {})
    await settle()

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2)
    removeSecond()
    await settle()
    await events.dispose()
  })

  it('contains command failures and retries both directions after ready', async () => {
    const { events, subscriber } = createHarness()
    subscriber.subscribe.mockRejectedValueOnce(new Error('subscribe failed'))
    subscriber.unsubscribe.mockRejectedValueOnce(
      new Error('unsubscribe failed'),
    )

    const remove = events.onRunEvent('run-1', () => {})
    await settle()
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1)

    subscriber.emit('ready')
    await settle()
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2)

    remove()
    await settle()
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1)

    subscriber.emit('ready')
    await settle()
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(2)
    await events.dispose()
  })
})
