import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Stream from 'effect/Stream'

import type {
  Channel,
  ChannelEvent,
  EventParams,
  EventPayload,
  SelectedEventUnion,
} from '../contract.ts'
import type { ChannelParamsOf, PubSubManagerOptions } from '../manager.ts'
import { PubSubManager } from '../manager.ts'

/** A publish or subscription failure: invalid params or payload, or the adapter. */
export class PubSubError extends Error {
  readonly _tag = 'PubSubError'
  constructor(cause: unknown) {
    super('PubSub operation failed', { cause })
    this.name = 'PubSubError'
  }
}

export class PubSub extends Context.Service<
  PubSub,
  {
    readonly publish: <Event extends ChannelEvent>(
      event: Event,
      params: EventParams<Event>,
      payload: EventPayload<Event>,
    ) => Effect.Effect<boolean, PubSubError>
    /** Unsubscribes when the stream ends or its consumer is interrupted. */
    readonly subscribe: <
      C extends Channel,
      Events extends Partial<Record<keyof C['events'], true>> = {},
    >(
      channel: C,
      params: ChannelParamsOf<C>,
      events?: Events,
    ) => Stream.Stream<SelectedEventUnion<C, Events>, PubSubError>
  }
>()('@nmtjs/pubsub/PubSub') {}

export function make(options: PubSubManagerOptions): PubSub['Service'] {
  const manager = new PubSubManager(options)
  return {
    publish: (event, params, payload) =>
      Effect.tryPromise({
        try: () => manager.publish(event, params, payload),
        catch: (cause) => new PubSubError(cause),
      }),
    subscribe: (channel, params, events) =>
      Stream.unwrap(
        Effect.tryPromise({
          // `interrupted` aborts only if the stream is interrupted while the
          // broker subscription is still being opened, whose result is lost.
          try: async (interrupted) => {
            const controller = new AbortController()
            const messages = await manager.subscribe(
              channel,
              params,
              events,
              AbortSignal.any([interrupted, controller.signal]),
            )
            return Stream.fromAsyncIterable(
              releasable(messages, controller),
              (cause) => new PubSubError(cause),
            )
          },
          catch: (cause) => new PubSubError(cause),
        }),
      ),
  }
}

// Effect awaits `return()` when a stream's scope closes, and an iterator's
// `return()` queues behind a `next()` that is waiting for a message. Aborting
// first ends that `next()`, so an idle subscription can be interrupted.
function releasable<A>(
  messages: AsyncIterable<A>,
  controller: AbortController,
): AsyncIterable<A> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = messages[Symbol.asyncIterator]()
      return {
        next: () => iterator.next(),
        return: async (value) => {
          controller.abort()
          return (await iterator.return?.(value)) ?? { done: true, value }
        },
      }
    },
  }
}

/** The adapter's lifetime stays with whoever built it. */
export const layer = (options: PubSubManagerOptions): Layer.Layer<PubSub> =>
  Layer.succeed(PubSub, make(options))
