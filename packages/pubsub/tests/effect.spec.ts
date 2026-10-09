import type * as Scope from 'effect/Scope'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import type { PubSubAdapter, PubSubMessage } from '../src/adapter.ts'
import type { EventPayload } from '../src/contract.ts'
import type { EffectSchema } from '../src/effect/index.ts'
import {
  defineChannel,
  layer,
  PubSub,
  PubSubConnectionLostError,
  PubSubError,
  schemaOf,
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

// Buffers from the moment `subscribe` resolves, as a real broker does once it
// acknowledges, and releases on abort even if the iterator is never pulled.
function broker(acknowledged: Promise<void> = Promise.resolve()) {
  const published: PubSubMessage[] = []
  const requested: string[] = []
  const open = new Set<string>()
  const queues = new Map<string, (message: PubSubMessage) => void>()
  const adapter: PubSubAdapter = {
    publish: async (channel, payload) => {
      const message = { channel, data: payload as PubSubMessage['data'] }
      published.push(message)
      queues.get(channel)?.(message)
      return true
    },
    async subscribe(channel, signal) {
      requested.push(channel)
      await acknowledged
      signal?.throwIfAborted()
      const queue: PubSubMessage[] = []
      let wake = Promise.withResolvers<void>()
      const release = () => {
        queues.delete(channel)
        open.delete(channel)
        wake.resolve()
      }
      queues.set(channel, (message) => {
        queue.push(message)
        wake.resolve()
      })
      open.add(channel)
      signal?.addEventListener('abort', release, { once: true })
      return (async function* () {
        try {
          while (!signal?.aborted) {
            const message = queue.shift()
            if (message) yield message
            else {
              await wake.promise
              wake = Promise.withResolvers<void>()
            }
          }
        } finally {
          release()
        }
      })()
    },
  }
  return { adapter, published, requested, open }
}

describe('Effect adapter', () => {
  it('publishes and streams typed events', async () => {
    const { adapter, published } = broker()
    const program = Effect.gen(function* () {
      const pubsub = yield* PubSub
      const subscribing = pubsub.subscribe(
        room,
        { roomId: 'a' },
        { seen: true },
      )
      expectTypeOf(subscribing).toEqualTypeOf<
        Effect.Effect<
          Stream.Stream<
            {
              readonly event: 'seen'
              readonly payload: Schema.Schema.Type<
                typeof Schema.DateTimeUtcFromString
              >
            },
            PubSubError
          >,
          PubSubError,
          Scope.Scope
        >
      >()
      const stream = yield* subscribing

      const at = Schema.decodeSync(Schema.DateTimeUtcFromString)(
        '2026-01-01T00:00:00.000Z',
      )
      yield* pubsub.publish(room.events.message, { roomId: 'a' }, { text: 'x' })
      yield* pubsub.publish(room.events.seen, { roomId: 'a' }, at)
      return yield* Stream.runHead(stream)
    })

    const received = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(layer({ adapter }))),
    )
    expect(published.map(({ data }) => data)).toEqual([
      { event: 'message', payload: { text: 'x' } },
      { event: 'seen', payload: '2026-01-01T00:00:00.000Z' },
    ])
    expect(received).toMatchObject({ _tag: 'Some', value: { event: 'seen' } })
  })

  it('completes subscribe only once the broker acknowledges the subscription', async () => {
    const ack = Promise.withResolvers<void>()
    const { adapter, requested } = broker(ack.promise)

    const received = await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        const opening = yield* Effect.forkChild(
          pubsub.subscribe(room, { roomId: 'a' }),
        )
        yield* Effect.promise(() => waitFor(() => requested.length === 1))
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
        expect(opening.pollUnsafe()).toBeUndefined()

        ack.resolve()
        const stream = yield* Fiber.join(opening)
        // Published before the stream is first pulled.
        yield* pubsub.publish(
          room.events.message,
          { roomId: 'a' },
          { text: 'x' },
        )
        return yield* Stream.runHead(stream)
      }).pipe(Effect.scoped, Effect.provide(layer({ adapter }))),
    )

    expect(received).toMatchObject({
      _tag: 'Some',
      value: { event: 'message', payload: { text: 'x' } },
    })
  })

  it('releases the subscription when the scope closes', async () => {
    const { adapter, open } = broker()

    await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        yield* pubsub.subscribe(room, { roomId: 'a' })
        expect(open.has('room:a')).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(layer({ adapter }))),
    )

    expect(open.size).toBe(0)
  })

  it('releases the subscription when the stream ends before the scope closes', async () => {
    const { adapter, open } = broker()

    await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        const stream = yield* pubsub.subscribe(room, { roomId: 'a' })
        yield* pubsub.publish(
          room.events.message,
          { roomId: 'a' },
          { text: 'x' },
        )
        yield* Stream.runDrain(Stream.take(stream, 1))
        yield* Effect.promise(() => waitFor(() => open.size === 0))
      }).pipe(Effect.scoped, Effect.provide(layer({ adapter }))),
    )
  })

  it('releases an idle subscription when its consumer is interrupted', async () => {
    const { adapter, open } = broker()

    await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        const stream = yield* pubsub.subscribe(room, { roomId: 'a' })
        const idle = yield* Effect.forkChild(Stream.runDrain(stream))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(idle)
        expect(open.size).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(layer({ adapter }))),
    )
  })

  it('releases a subscription interrupted while the broker subscription opens', async () => {
    const opening = Promise.withResolvers<void>()
    let released: AbortSignal | undefined
    const adapter: PubSubAdapter = {
      publish: async () => true,
      subscribe: async (_channel, signal) => {
        released = signal
        await opening.promise
        return (async function* () {})()
      },
    }

    await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        const fiber = yield* Effect.forkChild(
          Effect.scoped(pubsub.subscribe(room, { roomId: 'a' })),
        )
        yield* Effect.promise(() => waitFor(() => released !== undefined))
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.provide(layer({ adapter }))),
    )

    expect(released?.aborted).toBe(true)
    opening.resolve()
  })

  it('fails subscribe with a PubSubError when the broker subscription fails', async () => {
    const failure = new Error('SUBSCRIBE failed')
    const adapter: PubSubAdapter = {
      publish: async () => true,
      subscribe: () => Promise.reject(failure),
    }

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        return yield* pubsub.subscribe(room, { roomId: 'a' })
      }).pipe(Effect.scoped, Effect.flip, Effect.provide(layer({ adapter }))),
    )

    expect(error).toBeInstanceOf(PubSubError)
    expect(error.cause).toBe(failure)
  })

  it('fails the stream with a PubSubError caused by a lost connection', async () => {
    const lost = new PubSubConnectionLostError()
    const adapter: PubSubAdapter = {
      publish: async () => true,
      subscribe: async () => ({
        [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(lost) }),
      }),
    }

    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        const stream = yield* pubsub.subscribe(room, { roomId: 'a' })
        return yield* Stream.runDrain(stream)
      }).pipe(Effect.scoped, Effect.flip, Effect.provide(layer({ adapter }))),
    )

    expect(error).toBeInstanceOf(PubSubError)
    expect(error.cause).toBe(lost)
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

describe('Standard schemas in Effect channels', () => {
  const date = {
    decode: z.iso.datetime().transform((stored) => new Date(stored)),
    encode: z.date().transform((value) => value.toISOString()),
  }
  const text = z.object({ text: z.string().min(1) })
  const mixed = defineChannel({
    name: 'mixed',
    params: z.object({ roomId: z.string() }),
    key: ({ roomId }) => roomId,
    events: {
      seen: Schema.DateTimeUtcFromString,
      message: text,
      edited: date,
    },
  })

  it('types params and payloads from either library', () => {
    expectTypeOf<Parameters<NonNullable<typeof mixed.key>>[0]>().toEqualTypeOf<{
      roomId: string
    }>()
    expectTypeOf(mixed.events.message).toExtend<{
      readonly event: 'message'
    }>()
    void Effect.gen(function* () {
      const pubsub = yield* PubSub
      const stream = yield* pubsub.subscribe(mixed, { roomId: 'a' })
      expectTypeOf<Stream.Success<typeof stream>>().toEqualTypeOf<
        | {
            readonly event: 'seen'
            readonly payload: Schema.Schema.Type<
              typeof Schema.DateTimeUtcFromString
            >
          }
        | { readonly event: 'message'; readonly payload: { text: string } }
        | { readonly event: 'edited'; readonly payload: Date }
      >()
      // @ts-expect-error The payload is a Date.
      yield* pubsub.publish(mixed.events.edited, { roomId: 'a' }, 'now')
    })

    // Effect params work alongside Standard events, as before.
    defineChannel({
      name: 'effect-params',
      params: Schema.Struct({ roomId: Schema.String }),
      key: ({ roomId }) => roomId,
      events: { message: text },
    })
    void (() =>
      defineChannel({
        name: 'transformed',
        // Its Date output cannot be validated as its string input again.
        // @ts-expect-error A transforming Standard schema must declare both directions.
        events: { seen: Schema.DateTimeUtcFromString, edited: date.decode },
      }))
  })

  it('types unions of Effect and Standard schemas and Effect type parameters', () => {
    const text = Math.random() > 0.5 ? Schema.String : z.string()
    const either = defineChannel({ name: 'either', events: { text } })
    expectTypeOf<
      EventPayload<typeof either.events.text>
    >().toEqualTypeOf<string>()

    const make = <S extends EffectSchema>(schema: S) =>
      defineChannel({ name: 'generic', events: { value: schema } })
    expectTypeOf<
      EventPayload<
        ReturnType<typeof make<typeof Schema.DateFromString>>['events']['value']
      >
    >().toEqualTypeOf<Date>()
  })

  it('keeps Standard schemas as declared and converts only Effect schemas', () => {
    expect(mixed.events.message.payload).toBe(text)
    expect(mixed.events.edited.payload).toBe(date)
    expect(schemaOf(mixed.events.seen.payload)).toBe(
      Schema.DateTimeUtcFromString,
    )
  })

  it('publishes and streams payloads encoded by either library', async () => {
    const { adapter, published } = broker()
    const at = new Date('2026-01-01T00:00:00.000Z')
    const received = await Effect.runPromise(
      Effect.gen(function* () {
        const pubsub = yield* PubSub
        const stream = yield* pubsub.subscribe(mixed, { roomId: 'a' })
        yield* pubsub.publish(
          mixed.events.seen,
          { roomId: 'a' },
          Schema.decodeSync(Schema.DateTimeUtcFromString)(at.toISOString()),
        )
        yield* pubsub.publish(
          mixed.events.message,
          { roomId: 'a' },
          {
            text: 'x',
          },
        )
        yield* pubsub.publish(mixed.events.edited, { roomId: 'a' }, at)
        return yield* Stream.runCollect(Stream.take(stream, 3))
      }).pipe(Effect.scoped, Effect.provide(layer({ adapter }))),
    )

    expect(published).toEqual([
      {
        channel: 'mixed:a',
        data: { event: 'seen', payload: '2026-01-01T00:00:00.000Z' },
      },
      {
        channel: 'mixed:a',
        data: { event: 'message', payload: { text: 'x' } },
      },
      {
        channel: 'mixed:a',
        data: { event: 'edited', payload: '2026-01-01T00:00:00.000Z' },
      },
    ])
    const [seen, message, edited] = received
    expect(seen?.event).toBe('seen')
    expect(message).toEqual({ event: 'message', payload: { text: 'x' } })
    expect(edited).toEqual({ event: 'edited', payload: at })
  })

  it('rejects invalid Standard params and payloads with a PubSubError', async () => {
    const { adapter, published } = broker()
    const publish = (params: { roomId: string }, payload: { text: string }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const pubsub = yield* PubSub
          return yield* pubsub.publish(mixed.events.message, params, payload)
        }).pipe(Effect.flip, Effect.provide(layer({ adapter }))),
      )

    expect(await publish({ roomId: 'a' }, { text: '' })).toBeInstanceOf(
      PubSubError,
    )
    expect(await publish({ roomId: 1 as never }, { text: 'x' })).toBeInstanceOf(
      PubSubError,
    )
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
