import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import type { PubSubAdapter, PubSubMessage } from '../src/adapter.ts'
import {
  defineChannel,
  PubSubManager,
  PubSubSchemaError,
} from '../src/index.ts'

const date = {
  decode: z.iso.datetime().transform((stored) => new Date(stored)),
  encode: z.date().transform((value) => value.toISOString()),
}

const room = defineChannel({
  name: 'room',
  params: z.object({ roomId: z.string() }),
  key: ({ roomId }) => roomId,
  events: { message: z.object({ text: z.string().min(1) }), seen: date },
})

const lobby = defineChannel({ name: 'lobby', events: { ping: z.number() } })

// Delivers what was published to every open subscription, like a broker.
function loopback() {
  const published: PubSubMessage[] = []
  const listeners = new Set<(message: PubSubMessage) => void>()
  const adapter: PubSubAdapter = {
    publish: async (channel, payload) => {
      const message = { channel, data: payload as PubSubMessage['data'] }
      published.push(message)
      for (const listener of listeners) listener(message)
      return true
    },
    async subscribe(channel, signal) {
      const queue: PubSubMessage[] = []
      let wake = Promise.withResolvers<void>()
      const listener = (message: PubSubMessage) => {
        if (message.channel !== channel) return
        queue.push(message)
        wake.resolve()
      }
      listeners.add(listener)
      signal?.addEventListener('abort', () => wake.resolve())
      return (async function* () {
        try {
          while (!signal?.aborted) {
            while (queue.length) yield queue.shift()!
            wake = Promise.withResolvers()
            if (!queue.length) await wake.promise
          }
        } finally {
          listeners.delete(listener)
        }
      })()
    },
  }
  return { adapter, published }
}

describe('channel contracts', () => {
  it('publishes the encoded payload under the keyed channel and decodes it for subscribers', async () => {
    const { adapter, published } = loopback()
    const manager = new PubSubManager({ adapter })
    const abort = new AbortController()
    const stream = await manager.subscribe(
      room,
      { roomId: 'a/b' },
      undefined,
      abort.signal,
    )
    const iterator = stream[Symbol.asyncIterator]()
    const next = iterator.next()

    const at = new Date('2026-01-01T00:00:00Z')
    await manager.publish(room.events.seen, { roomId: 'a/b' }, at)
    expect(published).toEqual([
      {
        channel: 'room:a%2Fb',
        data: { event: 'seen', payload: '2026-01-01T00:00:00.000Z' },
      },
    ])
    expect((await next).value).toEqual({ event: 'seen', payload: at })
    abort.abort()
  })

  it('rejects an invalid payload or params before reaching the adapter', async () => {
    const { adapter, published } = loopback()
    const manager = new PubSubManager({ adapter })

    await expect(
      manager.publish(room.events.message, { roomId: 'a' }, { text: '' }),
    ).rejects.toBeInstanceOf(PubSubSchemaError)
    await expect(
      manager.publish(
        room.events.message,
        { roomId: 1 as never },
        { text: 'x' },
      ),
    ).rejects.toBeInstanceOf(PubSubSchemaError)
    expect(published).toEqual([])
  })

  it('rejects a payload JSON cannot carry before reaching the adapter', async () => {
    const { adapter, published } = loopback()
    const manager = new PubSubManager({ adapter })
    const events = defineChannel({
      name: 'events',
      events: {
        stamped: z.object({ at: z.date() }),
        counted: z.bigint(),
        empty: z.undefined(),
      },
    })

    await expect(
      manager.publish(events.events.stamped, undefined, { at: new Date() }),
    ).rejects.toThrow(new TypeError('Expected a JSON value at payload.at'))
    await expect(
      manager.publish(events.events.counted, undefined, 1n),
    ).rejects.toThrow(new TypeError('Expected a JSON value at payload'))
    expect(published).toEqual([])

    // JSON omits an absent payload, and subscribers decode it as absent.
    await expect(
      manager.publish(events.events.empty, undefined, undefined),
    ).resolves.toBe(true)
  })

  it('types params, payloads and the selected events', async () => {
    const manager = new PubSubManager({ adapter: loopback().adapter })
    void (async () => {
      const all = await manager.subscribe(room, { roomId: 'a' })
      for await (const message of all)
        expectTypeOf(message).toEqualTypeOf<
          | { readonly event: 'message'; readonly payload: { text: string } }
          | { readonly event: 'seen'; readonly payload: Date }
        >()
      const seen = await manager.subscribe(
        room,
        { roomId: 'a' },
        { seen: true },
      )
      for await (const message of seen)
        expectTypeOf(message.payload).toEqualTypeOf<Date>()
      await manager.publish(lobby.events.ping, undefined, 1)
      // @ts-expect-error The room is keyed by roomId.
      await manager.publish(room.events.seen, undefined, new Date())
      // @ts-expect-error The payload is a Date.
      await manager.publish(room.events.seen, { roomId: 'a' }, 'now')
    })

    void (() =>
      defineChannel({
        name: 'transformed',
        // Its Date output cannot be validated as its string input again.
        // @ts-expect-error A transforming schema must declare both directions.
        events: { seen: date.decode },
      }))
  })
})
