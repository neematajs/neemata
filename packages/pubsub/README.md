# @nmtjs/pubsub

Typed, ephemeral publish/subscribe across workers, processes and servers, for
[Effect](https://effect.website) (`^4.0.0`).

Delivery is at most once: there is no replay, and messages published while a
subscriber is disconnected are lost. Subscribers need their own way to recover a
gap, such as refetching state when they resubscribe.

## Channels

A channel names its events and, optionally, the params that key it. Payloads are
`effect/Schema` schemas, published through their JSON encoding, so a `Date`,
`DateTime` or `bigint` travels as the schema encodes it.

```ts
import { Channel } from '@nmtjs/pubsub'
import { Schema } from 'effect'

export const room = Channel.make('chat.room', {
  params: Schema.Struct({ roomId: Schema.String }),
  key: ({ roomId }) => roomId,
  events: {
    message: Schema.Struct({ text: Schema.String }),
    seen: Schema.DateTimeUtcFromString,
  },
})
```

Schemas may decode asynchronously but cannot require services. A value that a
schema lets through but JSON cannot carry, such as a `Date` under `Schema.Any`,
fails to publish with a `SchemaError`. The check reads a value's enumerable
properties only, so a `toJSON` hidden with `Object.defineProperty` slips past it:
Redis subscribers then receive what that `toJSON` returns, while in-memory
subscribers receive the value itself. Give such values a schema instead.

## Publishing and subscribing

```ts
import { NodeRuntime } from '@effect/platform-node'
import { PubSub } from '@nmtjs/pubsub'
import * as RedisBroker from '@nmtjs/pubsub/RedisBroker'
import { Effect, Layer, Stream } from 'effect'

const program = Effect.gen(function* () {
  const pubsub = yield* PubSub.PubSub
  const messages = yield* pubsub.subscribe(room, { roomId }, { message: true })
  // Live from here: a message published now is delivered.
  yield* pubsub.publish(room.events.message, { roomId }, { text: 'hello' })
  yield* Stream.runForEach(messages, ({ event, payload }) =>
    // event: 'message', payload: { text: string }
    Effect.log(event, payload),
  )
})

// `redis` is a connected ioredis or iovalkey client; see Brokers below.
const PubSubLive = PubSub.layer.pipe(Layer.provide(RedisBroker.layer(redis)))

program.pipe(Effect.scoped, Effect.provide(PubSubLive), NodeRuntime.runMain)
```

`subscribe` is a scoped Effect that completes once the broker subscription is live,
and yields a Stream of its messages. Omit the event selection to receive every event
of the channel. The subscription is released when the scope closes, or earlier when
the stream ends or its consumer stops; interrupting `subscribe` while it opens
releases it too. The stream can be consumed once.

Subscribe before reading the state that the messages update, so nothing committed in
between is missed. Where that ordering does not matter,
`Stream.unwrap(pubsub.subscribe(...))` gives a lazy stream that subscribes when it is
run and unsubscribes when it ends.

Malformed messages, events the channel does not declare and payloads that fail to
decode are logged and skipped. Publishing and subscribing each run in a span (`PubSub.publish`,
`PubSub.subscribe`), and everything is logged through Effect's logger.

## Errors

| Error                       | Meaning                                                                         |
| --------------------------- | ------------------------------------------------------------------------------- |
| `Schema.SchemaError`        | The params or the payload do not satisfy the channel's schemas.                 |
| `PubSubConnectionLostError` | The broker connection closed; messages may have been missed.                    |
| `PubSubError`               | The publish or the subscription failed, or its outcome is unknown; see `cause`. |

A `PubSubError` from a publish does not prove the message was not delivered: a
command that timed out may still reach the broker, so retrying a publish can
deliver it twice.

```ts
const watch = Effect.gen(function* () {
  const pubsub = yield* PubSub.PubSub
  const messages = yield* pubsub.subscribe(room, { roomId })
  // After subscribing, so nothing committed in between is missed.
  yield* refetch
  yield* Stream.runForEach(messages, apply)
}).pipe(
  Effect.scoped,
  // Resubscribes and refetches what the gap may have hidden.
  Effect.retry({
    while: (error) => error._tag === 'PubSubConnectionLostError',
  }),
)
```

## Brokers

`PubSub.layer` needs a `Broker`, the service that carries messages between
processes.
Closing a broker's layer ends its live subscriptions as finished streams.

### Redis and Valkey

`RedisBroker.layer(client)` takes an [ioredis](https://github.com/redis/ioredis) or
[iovalkey](https://github.com/valkey-io/iovalkey) client, both optional peers. It
shares one subscriber connection across channels and subscribes to each channel
once, however many local subscriptions it has. It does not own the client: build the
client in a layer of its own, so that it is closed after the broker.

```ts
class Redis extends Context.Service<Redis, IORedis>()('app/Redis') {}

const RedisLive = Layer.effect(
  Redis,
  Effect.acquireRelease(
    Effect.sync(() => new IORedis(url)),
    (client) => Effect.promise(() => client.quit()),
  ),
)

const BrokerLive = Layer.unwrap(
  Effect.gen(function* () {
    return RedisBroker.layer(yield* Redis)
  }),
).pipe(Layer.provide(RedisLive))

const PubSubLive = PubSub.layer.pipe(Layer.provide(BrokerLive))
```

When the subscriber connection drops, the broker does not resubscribe by itself:
live subscriptions fail with a `PubSubConnectionLostError` rather than delivering
their unread backlog first, so their consumers can resubscribe and refetch what they
missed. A stream may still hand out the messages it had already pulled. A
subscription opened while the connection is down waits for it to come back, and
fails once the client stops reconnecting.

### In memory

`Broker.layerMemory` delivers within the process that built it, for tests and
single-process deployments.

### Your own

```ts
import { Broker } from '@nmtjs/pubsub'

const BrokerLive = Layer.succeed(
  Broker.Broker,
  Broker.Broker.of({
    publish: (channel, message) => ..., // Effect<void, PubSubError>
    // Completes once the broker delivers the channel's messages; the
    // subscription lasts until the scope closes.
    subscribe: (channel) => ..., // Effect<Stream<Message, ...>, ..., Scope>
  }),
)
```
