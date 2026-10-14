import type * as Cause from 'effect/Cause'
import type * as Scope from 'effect/Scope'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'

import type { PubSubConnectionLostError, PubSubError } from './PubSubError.ts'

/** What travels over a broker channel; `payload` is the event's JSON encoding. */
export interface Message {
  readonly event: string
  readonly payload: unknown
}

/**
 * Carries messages between processes. Delivery is at most once: a broker
 * neither replays nor stores what is published while nobody is subscribed.
 */
export class Broker extends Context.Service<
  Broker,
  {
    readonly publish: (
      channel: string,
      message: Message,
    ) => Effect.Effect<void, PubSubError>
    /**
     * Completes once the broker delivers the channel's messages, so a message
     * published afterwards reaches the stream. The subscription lasts until
     * the scope closes. The stream fails with `PubSubConnectionLostError` when
     * messages may have been missed.
     */
    readonly subscribe: (
      channel: string,
    ) => Effect.Effect<
      Stream.Stream<Message, PubSubConnectionLostError | PubSubError>,
      PubSubConnectionLostError | PubSubError,
      Scope.Scope
    >
  }
>()('@nmtjs/pubsub/Broker') {}

/** Delivers within the process that built it, for tests and single processes. */
export const layerMemory: Layer.Layer<Broker> = Layer.effect(
  Broker,
  Effect.gen(function* () {
    const channels = new Map<string, Set<Queue.Queue<Message, Cause.Done>>>()
    let closed = false
    // Ends live subscriptions as finished streams.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closed = true
        for (const subscribers of channels.values())
          for (const queue of subscribers) Queue.endUnsafe(queue)
        channels.clear()
      }),
    )
    return Broker.of({
      publish: (channel, message) =>
        Effect.sync(() => {
          const subscribers = channels.get(channel)
          if (subscribers)
            for (const queue of subscribers) Queue.offerUnsafe(queue, message)
        }),
      subscribe: (channel) =>
        Effect.map(
          Effect.acquireRelease(
            Effect.flatMap(Queue.unbounded<Message, Cause.Done>(), (queue) => {
              if (closed) return Effect.interrupt
              let subscribers = channels.get(channel)
              if (!subscribers) channels.set(channel, (subscribers = new Set()))
              subscribers.add(queue)
              return Effect.succeed(queue)
            }),
            (queue) =>
              Effect.sync(() => {
                const subscribers = channels.get(channel)
                subscribers?.delete(queue)
                if (subscribers?.size === 0) channels.delete(channel)
                Queue.endUnsafe(queue)
                Queue.shutdownUnsafe(queue)
              }),
          ),
          (queue) => Stream.fromQueue(queue),
        ),
    })
  }),
)
