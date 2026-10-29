# PubSub

`@nmtjs/pubsub` is typed, ephemeral fanout across workers, processes and
servers, built on Effect. It requires `effect` `^4.1.0`; its Redis broker takes
the optional peer `ioredis` `^5.10.1` or `iovalkey` `^0.3.3`. The root exports
the `Broker`, `Channel`, `PubSub` and `PubSubError` modules; the Redis broker is
only at `@nmtjs/pubsub/RedisBroker`.

Delivery is at most once: no replay, offsets, consumer groups or
acknowledgements. Use it for live hints whose truth lives elsewhere (change
notifications, cache invalidation, progress), not as a durable event log or a
work queue; for those, write to durable storage (or use workflows) and publish
a hint after.

```ts
import { Channel, PubSub } from '@nmtjs/pubsub'
import * as RedisBroker from '@nmtjs/pubsub/RedisBroker'
import { Effect, Layer, Schema, Stream } from 'effect'

const room = Channel.make('chat.room', {
  params: Schema.Struct({ roomId: Schema.String }),
  key: ({ roomId }) => roomId,
  events: { message: Schema.Struct({ text: Schema.String }) },
})

const program = Effect.gen(function* () {
  const pubsub = yield* PubSub.PubSub
  const messages = yield* pubsub.subscribe(room, { roomId: 'r1' })
  yield* pubsub.publish(room.events.message, { roomId: 'r1' }, { text: 'hi' })
  yield* Stream.runForEach(messages, ({ event, payload }) =>
    Effect.log(event, payload),
  )
}).pipe(Effect.scoped)

// `redis` is a connected ioredis/iovalkey client the application owns.
const PubSubLive = PubSub.layer.pipe(Layer.provide(RedisBroker.layer(redis)))
```

- `Channel.make(name, { params?, key?, events })`; the broker channel is
  `name + ':' + encodeURIComponent(key(params))`. Schemas may decode
  asynchronously but cannot require services. Payloads travel as their
  schema's JSON encoding.
- An encoded payload JSON cannot carry (say a `Date` under `Schema.Any`) fails
  to publish with a `SchemaError`. The check reads enumerable properties only:
  a non-enumerable `toJSON` passes it, and Redis subscribers then receive what
  that `toJSON` returns while in-memory subscribers receive the value itself.
- `publish(event, params, payload)` is
  `Effect<void, SchemaError | PubSubError>`. Success is not a delivery
  receipt: publishing to a channel nobody subscribes to succeeds.
- `subscribe(channel, params, events?)` is a scoped Effect that completes once
  the broker subscription is live, yielding a single-use
  `Stream<Message, PubSubConnectionLostError | PubSubError>`. It releases when
  the scope closes, the stream ends or its consumer stops; interrupting it
  while it opens releases it too. `Stream.unwrap(pubsub.subscribe(...))` is the
  lazy form, with no point at which the subscription is known to be live.
- Malformed messages, undeclared events and undecodable payloads are logged
  and skipped; unselected events are skipped silently. Publish and subscribe
  run in `PubSub.publish` / `PubSub.subscribe` spans and log through Effect's
  logger.
- Errors: `Schema.SchemaError` for rejected params or payloads;
  `PubSubConnectionLostError` when the subscriber connection closed and
  messages may be missing; `PubSubError` (with `cause`) when a publish or
  subscription failed or its outcome is unknown. A timed-out publish may still
  be delivered, so retrying one can deliver it twice. Retry with
  `Effect.retry({ while: (e) => e._tag === 'PubSubConnectionLostError' })`
  around subscribe-then-refetch.
- `PubSub.layer` needs a `Broker`. `Broker.layerMemory` delivers within one
  process. A custom broker is `Broker.Broker.of({ publish, subscribe })`, where
  `subscribe(channel)` completes once the broker delivers the channel. Closing
  a broker's layer ends its live subscriptions as finished streams.
- `RedisBroker.layer(client)` does not own the client; provide the client from
  a layer of its own so it closes after the broker. Each layer duplicates the
  client into one subscriber connection shared by every channel, and sends
  one SUBSCRIBE per channel however many local subscriptions it has,
  serialized per channel.
- On a dropped subscriber connection the Redis broker does not resubscribe:
  established subscriptions fail with `PubSubConnectionLostError` ahead of
  their unread backlog (a stream may still hand out messages it had already
  pulled). A subscription opened while the connection is down waits for it
  and fails once the client stops reconnecting.
- An UNSUBSCRIBE that fails without a broker reply is treated as done, so the
  broker may keep sending a channel nobody listens to (dropped locally) until
  that channel's next subscribe cycle or a reconnect.
- Each subscription buffers without bound; a slow consumer grows memory.
  Malformed incoming JSON is logged and skipped.
