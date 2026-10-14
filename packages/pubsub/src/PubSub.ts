import type * as Schema from 'effect/Schema'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Result from 'effect/Result'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import type { Message } from './Broker.ts'
import type * as Channel from './Channel.ts'
import type { PubSubConnectionLostError, PubSubError } from './PubSubError.ts'
import { Broker } from './Broker.ts'

type Subscription<
  C extends Channel.Channel,
  Selected extends Channel.Selection<C> | undefined = undefined,
> = Effect.Effect<
  Stream.Stream<
    Channel.Message<C, Selected>,
    PubSubConnectionLostError | PubSubError
  >,
  Schema.SchemaError | PubSubConnectionLostError | PubSubError,
  Scope.Scope
>

export class PubSub extends Context.Service<
  PubSub,
  {
    /** Fails with a `SchemaError` for params or a payload the event rejects. */
    readonly publish: <E extends Channel.Event>(
      event: E,
      params: Channel.Event.Params<E>,
      payload: Channel.Event.Payload<E>,
    ) => Effect.Effect<void, Schema.SchemaError | PubSubError>
    /**
     * Completes once the broker subscription is live, so a message published
     * afterwards is delivered. The stream can be consumed once; it
     * unsubscribes when it ends or its consumer stops, and otherwise when the
     * scope closes. Omit `events`, or pass `{}`, to receive every event of the
     * channel.
     */
    readonly subscribe: {
      <C extends Channel.Channel>(
        channel: C,
        params: Channel.ParamsOf<C>,
      ): Subscription<C>
      // A required `events`, unlike an optional one, infers a selection that
      // may be `undefined` with it, so that it is typed as every event.
      <
        C extends Channel.Channel,
        const Selected extends Channel.Selection<C> | undefined,
      >(
        channel: C,
        params: Channel.ParamsOf<C>,
        events: Selected,
      ): Subscription<C, Selected>
    }
  }
>()('@nmtjs/pubsub/PubSub') {}

const skip = Result.fail(undefined)

export const make: Effect.Effect<PubSub['Service'], never, Broker> = Effect.gen(
  function* () {
    const broker = yield* Broker

    const publish: PubSub['Service']['publish'] = (event, params, payload) =>
      Effect.gen(function* () {
        const name = yield* event.channel.resolve(params)
        yield* Effect.annotateCurrentSpan('pubsub.channel', name)
        const encoded = yield* event.encode(payload)
        yield* broker.publish(name, { event: event.event, payload: encoded })
      }).pipe(
        Effect.withSpan('PubSub.publish', {
          attributes: { 'pubsub.event': event.event },
        }),
      )

    const decode = (
      channel: Channel.Channel,
      name: string,
      selected: Channel.Selection<Channel.Channel> | undefined,
    ) => {
      const events = channel.events as Record<string, Channel.Event | undefined>
      // An empty selection means every event, as `Channel.Message` types it.
      if (selected && Object.keys(selected).length === 0) selected = undefined
      return (message: Message) => {
        // Whatever is published to the broker channel arrives here, whoever
        // published it.
        if (typeof message?.event !== 'string')
          return Effect.as(
            Effect.logWarning('Malformed pubsub message').pipe(
              Effect.annotateLogs({ channel: name }),
            ),
            skip,
          )
        // Own properties only: an event name comes off the wire.
        const event = Object.hasOwn(events, message.event)
          ? events[message.event]
          : undefined
        if (!event)
          return Effect.as(
            Effect.logWarning('Unknown subscription event').pipe(
              Effect.annotateLogs({ channel: name, event: message.event }),
            ),
            skip,
          )
        if (selected && selected[message.event] !== true)
          return Effect.succeed(skip)
        return event.decode(message.payload).pipe(
          Effect.map((payload) => ({ event: event.event, payload })),
          Effect.tapError((error) =>
            Effect.logError('Unable to decode event payload', error).pipe(
              Effect.annotateLogs({ channel: name, event: message.event }),
            ),
          ),
          Effect.result,
        )
      }
    }

    const subscribe = (
      channel: Channel.Channel,
      params: unknown,
      selected?: Channel.Selection<Channel.Channel>,
    ) =>
      Effect.gen(function* () {
        const name = yield* channel.resolve(params)
        yield* Effect.annotateCurrentSpan('pubsub.channel', name)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // Its own scope, so the stream can release the broker
            // subscription as soon as it ends rather than when the caller's
            // scope closes.
            const scope = yield* Scope.fork(yield* Effect.scope)
            const close = Scope.close(scope, Exit.void)
            const messages = yield* restore(broker.subscribe(name)).pipe(
              Scope.provide(scope),
              Effect.onError(() => close),
            )
            return messages.pipe(
              Stream.filterMapEffect(decode(channel, name, selected)),
              Stream.ensuring(close),
            )
          }),
        )
      }).pipe(Effect.withSpan('PubSub.subscribe'))

    return PubSub.of({
      publish,
      subscribe: subscribe as PubSub['Service']['subscribe'],
    })
  },
)

/** The broker's lifetime stays with the layer that provides it. */
export const layer: Layer.Layer<PubSub, never, Broker> = Layer.effect(
  PubSub,
  make,
)
