import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import { Broker, Channel, PubSub, PubSubError } from '../../src/index.ts'

const room = Channel.make('room', {
  params: Schema.Struct({ roomId: Schema.String }),
  key: ({ roomId }) => roomId,
  events: {
    seen: Schema.DateTimeUtcFromString,
    message: Schema.Struct({ text: Schema.NonEmptyString }),
  },
})

const lobby = Channel.make('lobby', { events: { ping: Schema.Number } })

const at = Schema.decodeSync(Schema.DateTimeUtcFromString)(
  '2026-01-01T00:00:00.000Z',
)

// Wraps the in-memory broker to observe what reaches it, and optionally holds
// each subscription open until `acknowledged`, as a real broker does.
function broker(acknowledged: Effect.Effect<void> = Effect.void) {
  const published: Array<{ channel: string; message: Broker.Message }> = []
  const requested: string[] = []
  const open = new Set<string>()
  const layer = Layer.effect(
    Broker.Broker,
    Effect.gen(function* () {
      const memory = yield* Broker.Broker
      return Broker.Broker.of({
        publish: (channel, message) => {
          published.push({ channel, message })
          return memory.publish(channel, message)
        },
        subscribe: (channel) =>
          Effect.gen(function* () {
            requested.push(channel)
            yield* acknowledged
            const messages = yield* memory.subscribe(channel)
            yield* Effect.acquireRelease(
              Effect.sync(() => open.add(channel)),
              () => Effect.sync(() => open.delete(channel)),
            )
            return messages
          }),
      })
    }),
  ).pipe(Layer.provide(Broker.layerMemory))
  return {
    published,
    requested,
    open,
    layer: PubSub.layer.pipe(Layer.provideMerge(layer)),
  }
}

const failing = (
  subscribe: Broker.Broker['Service']['subscribe'],
): Layer.Layer<PubSub.PubSub> =>
  PubSub.layer.pipe(
    Layer.provide(
      Layer.succeed(
        Broker.Broker,
        Broker.Broker.of({ publish: () => Effect.void, subscribe }),
      ),
    ),
  )

function logs() {
  const messages: unknown[] = []
  const layer = Logger.layer([
    Logger.make<unknown, void>(({ message }) => {
      messages.push(Array.isArray(message) ? message[0] : message)
    }),
  ])
  return { messages, layer }
}

describe('PubSub', () => {
  it.effect('publishes events through their JSON encoding', () => {
    const { layer, published } = broker()
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      yield* pubsub.publish(room.events.message, { roomId: 'a' }, { text: 'x' })
      yield* pubsub.publish(room.events.seen, { roomId: 'a/b' }, at)
      yield* pubsub.publish(lobby.events.ping, undefined, 1)

      expect(published).toEqual([
        {
          channel: 'room:a',
          message: { event: 'message', payload: { text: 'x' } },
        },
        {
          channel: 'room:a%2Fb',
          message: { event: 'seen', payload: '2026-01-01T00:00:00.000Z' },
        },
        { channel: 'lobby', message: { event: 'ping', payload: 1 } },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('streams the decoded events of the subscribed channel', () => {
    const { layer } = broker()
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      const subscribing = pubsub.subscribe(room, { roomId: 'a' })
      expectTypeOf(subscribing).toEqualTypeOf<
        Effect.Effect<
          Stream.Stream<
            | {
                readonly event: 'seen'
                readonly payload: Schema.Schema.Type<
                  typeof Schema.DateTimeUtcFromString
                >
              }
            | {
                readonly event: 'message'
                readonly payload: { readonly text: string }
              },
            PubSubError.PubSubConnectionLostError | PubSubError.PubSubError
          >,
          | Schema.SchemaError
          | PubSubError.PubSubConnectionLostError
          | PubSubError.PubSubError,
          Scope.Scope
        >
      >()
      const messages = yield* subscribing

      yield* pubsub.publish(room.events.message, { roomId: 'b' }, { text: 'x' })
      yield* pubsub.publish(room.events.seen, { roomId: 'a' }, at)
      yield* pubsub.publish(room.events.message, { roomId: 'a' }, { text: 'y' })

      expect(yield* Stream.runCollect(Stream.take(messages, 2))).toEqual([
        { event: 'seen', payload: at },
        { event: 'message', payload: { text: 'y' } },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('delivers every event without a selection', () => {
    const { layer } = broker()
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      // Typed as selecting `seen`, but `undefined`, so every event arrives.
      const optional = undefined as { seen: true } | undefined
      const empty = yield* pubsub.subscribe(room, { roomId: 'a' }, {})
      const none = yield* pubsub.subscribe(room, { roomId: 'a' }, optional)
      type Every = Stream.Stream<
        Channel.Message<typeof room>,
        PubSubError.PubSubConnectionLostError | PubSubError.PubSubError
      >
      expectTypeOf(empty).toEqualTypeOf<Every>()
      expectTypeOf(none).toEqualTypeOf<Every>()

      yield* pubsub.publish(room.events.seen, { roomId: 'a' }, at)
      yield* pubsub.publish(room.events.message, { roomId: 'a' }, { text: 'y' })

      for (const messages of [empty, none])
        expect(yield* Stream.runCollect(Stream.take(messages, 2))).toEqual([
          { event: 'seen', payload: at },
          { event: 'message', payload: { text: 'y' } },
        ])
    }).pipe(Effect.provide(layer))
  })

  it.effect('delivers an event whatever it is named', () => {
    const { layer } = broker()
    const odd = Channel.make('odd', {
      events: { ['__proto__']: Schema.String, constructor: Schema.Number },
    })
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      const messages = yield* pubsub.subscribe(odd, undefined)

      yield* pubsub.publish(odd.events['__proto__'], undefined, 'x')
      yield* pubsub.publish(odd.events.constructor, undefined, 1)

      expect(yield* Stream.runCollect(Stream.take(messages, 2))).toEqual([
        { event: '__proto__', payload: 'x' },
        { event: 'constructor', payload: 1 },
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'delivers only the selected events, without reporting the rest',
    () => {
      const { layer } = broker()
      const logged = logs()
      return Effect.gen(function* () {
        const pubsub = yield* PubSub.PubSub
        const messages = yield* pubsub.subscribe(
          room,
          { roomId: 'a' },
          { seen: true },
        )
        expectTypeOf(messages).toEqualTypeOf<
          Stream.Stream<
            {
              readonly event: 'seen'
              readonly payload: Schema.Schema.Type<
                typeof Schema.DateTimeUtcFromString
              >
            },
            PubSubError.PubSubConnectionLostError | PubSubError.PubSubError
          >
        >()
        expectTypeOf<
          Channel.Message<typeof room, { seen: true } | { message: true }>
        >().toEqualTypeOf<Channel.Message<typeof room>>()
        // As inferred from `condition ? { seen: true } : { message: true }`.
        expectTypeOf<
          Channel.Message<
            typeof room,
            | { seen: true; message?: undefined }
            | { message: true; seen?: undefined }
          >
        >().toEqualTypeOf<Channel.Message<typeof room>>()

        yield* pubsub.publish(
          room.events.message,
          { roomId: 'a' },
          { text: 'x' },
        )
        yield* pubsub.publish(room.events.seen, { roomId: 'a' }, at)

        expect(yield* Stream.runHead(messages)).toMatchObject({
          _tag: 'Some',
          value: { event: 'seen', payload: at },
        })
        expect(logged.messages).toEqual([])
      }).pipe(Effect.provide(layer), Effect.provide(logged.layer))
    },
  )

  it.effect(
    'skips and reports events the channel does not declare or cannot decode',
    () => {
      const { layer } = broker()
      const logged = logs()
      return Effect.gen(function* () {
        const pubsub = yield* PubSub.PubSub
        const raw = yield* Broker.Broker
        const messages = yield* pubsub.subscribe(room, { roomId: 'a' })

        // Anything can be published to the broker channel.
        for (const malformed of [null, 'text', {}])
          yield* raw.publish('room:a', malformed as never)
        yield* raw.publish('room:a', { event: 'renamed', payload: {} })
        // An inherited property is not an event of the channel.
        yield* raw.publish('room:a', { event: 'toString', payload: {} })
        yield* raw.publish('room:a', {
          event: 'message',
          payload: { text: '' },
        })
        yield* pubsub.publish(
          room.events.message,
          { roomId: 'a' },
          { text: 'x' },
        )

        expect(yield* Stream.runHead(messages)).toMatchObject({
          _tag: 'Some',
          value: { event: 'message', payload: { text: 'x' } },
        })
        expect(logged.messages).toEqual([
          'Malformed pubsub message',
          'Malformed pubsub message',
          'Malformed pubsub message',
          'Unknown subscription event',
          'Unknown subscription event',
          'Unable to decode event payload',
        ])
      }).pipe(Effect.provide(layer), Effect.provide(logged.layer))
    },
  )

  it.effect(
    'completes subscribe only once the broker acknowledges the subscription',
    () =>
      Effect.gen(function* () {
        const acknowledged = yield* Deferred.make<void>()
        const { layer, requested } = broker(Deferred.await(acknowledged))

        yield* Effect.gen(function* () {
          const pubsub = yield* PubSub.PubSub
          const opening = yield* Effect.forkChild(
            pubsub.subscribe(room, { roomId: 'a' }),
          )
          yield* Effect.yieldNow
          expect(requested).toEqual(['room:a'])
          expect(opening.pollUnsafe()).toBeUndefined()

          yield* Deferred.succeed(acknowledged, undefined)
          const messages = yield* Fiber.join(opening)
          // Published before the stream is first pulled.
          yield* pubsub.publish(
            room.events.message,
            { roomId: 'a' },
            { text: 'x' },
          )
          expect(yield* Stream.runHead(messages)).toMatchObject({
            _tag: 'Some',
            value: { event: 'message', payload: { text: 'x' } },
          })
        }).pipe(Effect.provide(layer))
      }),
  )

  it.effect('releases the subscription when the scope closes', () => {
    const { layer, open } = broker()
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* pubsub.subscribe(room, { roomId: 'a' })
          expect(open.has('room:a')).toBe(true)
        }),
      )
      expect(open.size).toBe(0)
    }).pipe(Effect.provide(layer))
  })

  it.effect(
    'releases the subscription when the stream ends before the scope closes',
    () => {
      const { layer, open } = broker()
      return Effect.gen(function* () {
        const pubsub = yield* PubSub.PubSub
        const messages = yield* pubsub.subscribe(room, { roomId: 'a' })
        yield* pubsub.publish(
          room.events.message,
          { roomId: 'a' },
          { text: 'x' },
        )
        yield* Stream.runDrain(Stream.take(messages, 1))
        expect(open.size).toBe(0)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    'releases an idle subscription when its consumer is interrupted',
    () => {
      const { layer, open } = broker()
      return Effect.gen(function* () {
        const pubsub = yield* PubSub.PubSub
        const messages = yield* pubsub.subscribe(room, { roomId: 'a' })
        const idle = yield* Effect.forkChild(Stream.runDrain(messages))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(idle)
        expect(open.size).toBe(0)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    'releases a subscription interrupted while the broker subscription opens',
    () => {
      let released = false
      const layer = failing(() =>
        Effect.andThen(
          Effect.addFinalizer(() => Effect.sync(() => (released = true))),
          Effect.never,
        ),
      )
      return Effect.gen(function* () {
        const pubsub = yield* PubSub.PubSub
        const opening = yield* Effect.forkChild(
          pubsub.subscribe(room, { roomId: 'a' }),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(opening)
        // Before the scope it was opened in closes.
        expect(released).toBe(true)
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect(
    'interrupts a subscription whose params are still being validated',
    () => {
      const { layer, requested } = broker()
      const fields = Schema.Struct({ roomId: Schema.String })
      const slow = Channel.make('slow', {
        params: fields.pipe(
          Schema.decodeTo(fields, {
            decode: SchemaGetter.transformEffect(() => Effect.never),
            encode: SchemaGetter.passthrough(),
          }),
        ),
        key: ({ roomId }) => roomId,
        events: { ping: Schema.Number },
      })
      return Effect.gen(function* () {
        const pubsub = yield* PubSub.PubSub
        const opening = yield* Effect.forkChild(
          pubsub.subscribe(slow, { roomId: 'a' }),
        )
        yield* Effect.yieldNow
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(opening))
        yield* Effect.yieldNow
        yield* Effect.yieldNow
        expect(interrupting.pollUnsafe()).toBeDefined()
        expect(requested).toEqual([])
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect('fails subscribe with the error of the broker subscription', () => {
    const failure = new PubSubError.PubSubError({ cause: 'SUBSCRIBE failed' })
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      const error = yield* Effect.flip(pubsub.subscribe(room, { roomId: 'a' }))
      expect(error).toBe(failure)
    }).pipe(Effect.provide(failing(() => Effect.fail(failure))))
  })

  it.effect('fails the stream when the broker loses its connection', () => {
    const lost = new PubSubError.PubSubConnectionLostError()
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      const messages = yield* pubsub.subscribe(room, { roomId: 'a' })
      const recovered = yield* Stream.runDrain(messages).pipe(
        Effect.as('drained'),
        Effect.catchTag('PubSubConnectionLostError', () =>
          Effect.succeed('resubscribe'),
        ),
      )
      expect(recovered).toBe('resubscribe')
    }).pipe(Effect.provide(failing(() => Effect.succeed(Stream.fail(lost)))))
  })

  it.effect(
    'rejects a payload its schema lets through but JSON cannot carry',
    () => {
      const { layer, published } = broker()
      const loose = Channel.make('loose', {
        events: { any: Schema.Struct({ value: Schema.Any }) },
      })
      return Effect.gen(function* () {
        const pubsub = yield* PubSub.PubSub

        // A subscriber would be handed something else, or nothing at all.
        for (const value of [undefined, Number.NaN, new Date(0), new Map()])
          expect(
            Schema.isSchemaError(
              yield* Effect.flip(
                pubsub.publish(loose.events.any, undefined, { value }),
              ),
            ),
          ).toBe(true)
        yield* pubsub.publish(loose.events.any, undefined, { value: [1, 'x'] })

        expect(published).toEqual([
          {
            channel: 'loose',
            message: { event: 'any', payload: { value: [1, 'x'] } },
          },
        ])
      }).pipe(Effect.provide(layer))
    },
  )

  it.effect('ends live subscriptions when the in-memory broker closes', () =>
    Effect.gen(function* () {
      const closing = yield* Scope.make()
      const context = yield* Layer.buildWithScope(
        PubSub.layer.pipe(Layer.provide(Broker.layerMemory)),
        closing,
      )
      // In the test's scope, which outlives the broker's.
      const pubsub = Context.get(context, PubSub.PubSub)
      const messages = yield* pubsub.subscribe(lobby, undefined)
      const received: unknown[] = []
      const consumed = yield* Effect.forkChild(
        Stream.runForEach(messages, (item) =>
          Effect.sync(() => received.push(item)),
        ),
      )
      yield* pubsub.publish(lobby.events.ping, undefined, 1)
      yield* Effect.yieldNow

      yield* Scope.close(closing, Exit.void)

      expect(yield* Fiber.await(consumed)).toEqual(Exit.void)
      expect(received).toEqual([{ event: 'ping', payload: 1 }])
      expect(
        Exit.hasInterrupts(
          yield* Effect.exit(pubsub.subscribe(lobby, undefined)),
        ),
      ).toBe(true)
    }),
  )

  it.effect('rejects a payload or params the channel does not accept', () => {
    const { layer, published, requested } = broker()
    return Effect.gen(function* () {
      const pubsub = yield* PubSub.PubSub
      const invalid = { roomId: 1 } as unknown as { roomId: string }

      const errors = yield* Effect.all([
        Effect.flip(
          pubsub.publish(room.events.message, { roomId: 'a' }, { text: '' }),
        ),
        Effect.flip(
          pubsub.publish(room.events.message, invalid, { text: 'x' }),
        ),
        Effect.flip(pubsub.subscribe(room, invalid)),
      ])

      for (const error of errors) expect(Schema.isSchemaError(error)).toBe(true)
      expect(published).toEqual([])
      expect(requested).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})
