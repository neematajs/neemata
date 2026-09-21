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
  disconnect: ReturnType<typeof vi.fn>
}

const createHarness = () => {
  const subscriber = new EventEmitter() as FakeSubscriber
  subscriber.status = 'ready'
  subscriber.subscribe = vi.fn().mockResolvedValue(undefined)
  subscriber.unsubscribe = vi.fn().mockResolvedValue(undefined)
  subscriber.quit = vi.fn().mockResolvedValue(undefined)
  subscriber.disconnect = vi.fn()
  const events = new WakeEvents(
    { duplicate: () => subscriber } as unknown as WorkflowRedisClient,
    new Keys('nmtjs:test:review-redis:'),
  )
  return { events, subscriber }
}

describe('Redis workflow wake events disposal', () => {
  it('force-closes the subscriber when a graceful quit fails', async () => {
    const { events, subscriber } = createHarness()
    subscriber.quit.mockRejectedValueOnce(new Error('Connection is closed.'))

    await expect(events.dispose()).resolves.toBeUndefined()

    expect(subscriber.disconnect).toHaveBeenCalledTimes(1)
  })

  it('leaves a gracefully closed subscriber alone', async () => {
    const { events, subscriber } = createHarness()

    await events.dispose()

    expect(subscriber.quit).toHaveBeenCalledTimes(1)
    expect(subscriber.disconnect).not.toHaveBeenCalled()
  })

  it('makes concurrent and later callers wait for the same closure', async () => {
    const { events, subscriber } = createHarness()
    let rejectQuit!: (error: unknown) => void
    subscriber.quit.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectQuit = reject
      }),
    )

    const first = events.dispose()
    let secondSettled = false
    const second = events.dispose().then(() => {
      secondSettled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(secondSettled).toBe(false)

    rejectQuit(new Error('Connection is closed.'))
    await Promise.all([first, second])
    await events.dispose()

    expect(subscriber.quit).toHaveBeenCalledTimes(1)
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1)
  })
})
