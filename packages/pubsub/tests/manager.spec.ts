import type { Readable } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'

import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import type { PubSubAdapter, PubSubMessage } from '../src/adapter.ts'
import { PubSubManager } from '../src/manager.ts'

const channel = SubscriptionContract({
  namespace: 'chat',
  params: t.object({ roomId: t.string() }),
  key: ({ roomId }) => roomId,
  events: {
    message: EventContract({ payload: t.object({ text: t.string() }) }),
  },
})

function createManager(subscribe: PubSubAdapter['subscribe']) {
  return new PubSubManager({
    logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
    adapter: { publish: async () => true, subscribe },
  })
}

async function subscribeStream(manager: PubSubManager, signal?: AbortSignal) {
  const stream = await manager.subscribe(
    channel,
    { roomId: 'general' },
    undefined,
    signal,
  )
  return stream as unknown as Readable
}

function message(text: string): PubSubMessage {
  return {
    channel: 'chat:general',
    data: { event: 'message', payload: { text } },
  }
}

describe('PubSubManager subscription stream', () => {
  it('pauses the pump instead of buffering unboundedly for a slow consumer', async () => {
    const total = 100
    let pulled = 0
    const manager = createManager(async function* () {
      for (let i = 0; i < total; i++) {
        pulled++
        yield message(`msg-${i}`)
      }
    })
    const stream = await subscribeStream(manager)

    // Kick the pump without consuming anything
    expect(stream.read()).toBeNull()
    await tick()
    await tick()

    // push() returned false at the high water mark and the pump paused
    expect(pulled).toBeLessThan(total)
    expect(pulled).toBeLessThanOrEqual(stream.readableHighWaterMark + 1)

    const received: unknown[] = []
    for await (const item of stream) received.push(item)

    expect(received).toHaveLength(total)
    expect(pulled).toBe(total)
  })

  it('does not double-push end of stream when read is re-entered', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = createManager(async function* () {
      yield message('only')
      await gate
    })
    const stream = await subscribeStream(manager)

    const errors: unknown[] = []
    const received: unknown[] = []
    stream.on('error', (error) => errors.push(error))
    stream.on('data', (item) => {
      received.push(item)
      // Flowing mode re-invokes read() while the pump is still awaiting;
      // ending the iterator now overlaps both paths to end of stream
      release()
    })
    await new Promise((resolve) => stream.once('end', resolve))
    await tick()

    expect(errors).toEqual([])
    expect(received).toEqual([{ event: 'message', payload: { text: 'only' } }])
  })

  it('destroys the stream when the adapter iterator fails', async () => {
    const failure = new Error('adapter failed')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = createManager(async function* () {
      yield message('first')
      // Let the consumer drain the first message before failing, since
      // destroy discards anything still buffered
      await gate
      throw failure
    })
    const stream = await subscribeStream(manager)

    const received: unknown[] = []
    await expect(async () => {
      for await (const item of stream) {
        received.push(item)
        release()
      }
    }).rejects.toBe(failure)

    expect(received).toEqual([{ event: 'message', payload: { text: 'first' } }])
    expect(stream.destroyed).toBe(true)
  })

  it('ends the stream gracefully when the adapter iterator aborts', async () => {
    const abortError = Object.assign(new Error('aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    })
    const manager = createManager(async function* () {
      yield message('first')
      throw abortError
    })
    const stream = await subscribeStream(manager)

    const received: unknown[] = []
    for await (const item of stream) received.push(item)

    expect(received).toEqual([{ event: 'message', payload: { text: 'first' } }])
  })

  it('ends the stream gracefully when a caller signal aborts', async () => {
    const controller = new AbortController()
    const manager = createManager(async function* (_channel, signal) {
      yield message('first')
      // Blocked until the combined signal (caller + manager-owned) aborts
      await new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        })
      })
    })
    const stream = await subscribeStream(manager, controller.signal)

    const received: unknown[] = []
    const consumed = (async () => {
      for await (const item of stream) received.push(item)
    })()
    await tick()
    controller.abort()
    await consumed

    expect(received).toEqual([{ event: 'message', payload: { text: 'first' } }])
  })

  it('aborts an adapter iterator blocked on the next message when destroyed', async () => {
    let finalized = false
    const manager = createManager(async function* (_channel, signal) {
      try {
        yield message('first')
        // Blocked mid-next() like an adapter waiting for the broker; only
        // the abort signal can release it — return() alone queues forever
        await new Promise<never>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          })
        })
      } finally {
        finalized = true
      }
    })
    const stream = await subscribeStream(manager)

    stream.read()
    await tick()
    stream.destroy()
    await tick()

    expect(finalized).toBe(true)
  })

  it('stops the pump and releases the adapter iterator on destroy', async () => {
    let finalized = false
    let pulled = 0
    const manager = createManager(async function* () {
      try {
        while (true) {
          pulled++
          yield message(`msg-${pulled}`)
        }
      } finally {
        finalized = true
      }
    })
    const stream = await subscribeStream(manager)

    stream.read()
    await tick()
    stream.destroy()
    await tick()

    expect(finalized).toBe(true)
    const pulledAtDestroy = pulled
    await tick()
    expect(pulled).toBe(pulledAtDestroy)
  })
})
