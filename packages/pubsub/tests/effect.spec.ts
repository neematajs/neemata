import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { PubSubAdapter, PubSubMessage } from '../src/adapter.ts'
import {
  defineChannel,
  layer,
  PubSub,
  PubSubError,
} from '../src/effect/index.ts'

const room = defineChannel({
  name: 'room',
  params: Schema.Struct({ roomId: Schema.String }),
  key: ({ roomId }) => roomId,
  events: {
    seen: Schema.DateTimeUtcFromString,
    message: Schema.Struct({ text: Schema.NonEmptyString }),
  },
})

function broker() {
  const published: PubSubMessage[] = []
  const open = new Set<string>()
  const waiting = new Set<(message: PubSubMessage) => void>()
  const adapter: PubSubAdapter = {
    publish: async (channel, payload) => {
      const message = { channel, data: payload as PubSubMessage['data'] }
      published.push(message)
      for (const deliver of waiting) deliver(message)
      return true
    },
    async *subscribe(channel, signal) {
      open.add(channel)
      try {
        while (!signal?.aborted) {
          const next = Promise.withResolvers<PubSubMessage | undefined>()
          waiting.add(next.resolve)
          signal?.addEventListener('abort', () => next.resolve(undefined))
          const message = await next.promise
          waiting.delete(next.resolve)
          if (message?.channel === channel) yield message
        }
      } finally {
        open.delete(channel)
      }
    },
  }
  return { adapter, published, open }
}

describe('Effect adapter', () => {
  it('publishes and streams typed events, and unsubscribes on interruption', async () => {
    const { adapter, published, open } = broker()
    const program = Effect.gen(function* () {
      const pubsub = yield* PubSub
      const stream = pubsub.subscribe(room, { roomId: 'a' }, { seen: true })
      expectTypeOf(stream).toEqualTypeOf<
        Stream.Stream<
          {
            readonly event: 'seen'
            readonly payload: Schema.Schema.Type<
              typeof Schema.DateTimeUtcFromString
            >
          },
          PubSubError
        >
      >()
      const first = yield* Effect.forkChild(Stream.runHead(stream))
      yield* Effect.promise(() => waitFor(() => open.has('room:a')))

      const at = Schema.decodeSync(Schema.DateTimeUtcFromString)(
        '2026-01-01T00:00:00.000Z',
      )
      yield* pubsub.publish(room.events.message, { roomId: 'a' }, { text: 'x' })
      yield* pubsub.publish(room.events.seen, { roomId: 'a' }, at)
      const received = yield* Fiber.join(first)

      const idle = yield* Effect.forkChild(Stream.runDrain(stream))
      yield* Effect.promise(() => waitFor(() => open.has('room:a')))
      yield* Fiber.interrupt(idle)
      return received
    })

    const received = await Effect.runPromise(
      program.pipe(Effect.provide(layer({ adapter }))),
    )
    expect(published.map(({ data }) => data)).toEqual([
      { event: 'message', payload: { text: 'x' } },
      { event: 'seen', payload: '2026-01-01T00:00:00.000Z' },
    ])
    expect(received).toMatchObject({ _tag: 'Some', value: { event: 'seen' } })
    await waitFor(() => open.size === 0)
  })

  it('fails with a PubSubError for an invalid payload', async () => {
    const { adapter, published } = broker()
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        return yield* pubsub.publish(
          room.events.message,
          { roomId: 'a' },
          { text: '' },
        )
      }).pipe(Effect.flip, Effect.provide(layer({ adapter }))),
    )
    expect(exit._tag).toBe('Success')
    if (exit._tag === 'Success') expect(exit.value).toBeInstanceOf(PubSubError)
    expect(published).toEqual([])
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error('Timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
