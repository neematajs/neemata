# @nmtjs/pubsub

Typed, ephemeral publish/subscribe across workers, processes and servers.

Delivery is at most once: there is no replay, and messages published while a
subscriber is disconnected are lost. Subscribers need their own way to recover a
gap, such as refetching state when they resubscribe.

## Channels

A channel names its events and, optionally, the params that key it. Schemas are
Standard Schemas, so any conforming library works. A single schema serves a payload
that is published as it is; a payload with a different published form declares both
directions.

```ts
import { defineChannel } from '@nmtjs/pubsub'
import * as z from 'zod'

export const room = defineChannel({
  name: 'chat.room',
  params: z.object({ roomId: z.string() }),
  key: ({ roomId }) => roomId,
  events: {
    message: z.object({ text: z.string() }),
    seen: {
      decode: z.iso.datetime().transform((stored) => new Date(stored)),
      encode: z.date().transform((value) => value.toISOString()),
    },
  },
})
```

Schemas must validate synchronously. A lone schema that transforms its input is
rejected at compile time. Messages travel as JSON, so an encoded payload must be
plain JSON: publishing a `Date`, `bigint` or other value JSON would alter throws a
`TypeError`; declare `{ decode, encode }` to publish such values.

## Publishing and subscribing

```ts
import { PubSubManager } from '@nmtjs/pubsub'
import { createRedisAdapter } from '@nmtjs/pubsub/redis'

const adapter = await createRedisAdapter(redis) // an ioredis or iovalkey client
const pubsub = new PubSubManager({ adapter, logger })

await pubsub.publish(room.events.message, { roomId }, { text: 'hello' })

const messages = await pubsub.subscribe(
  room,
  { roomId },
  { message: true },
  signal,
)
for await (const { event, payload } of messages) {
  // event: 'message', payload: { text: string }
}
```

`subscribe()` resolves once the broker subscription is live, so a message published
after it resolves is delivered. Omit the event selection to receive every event of
the channel. Unknown events and payloads that fail to decode are logged and skipped.
Aborting the signal, or leaving the loop, releases the subscription.

Each Redis adapter shares one subscriber connection across channels and subscribes
to each channel once, however many local listeners it has. It does not own the
client passed to it: call `adapter.dispose()` before closing the client; disposal
ends live subscriptions. `logger` is optional and accepts a Pino logger.

When the subscriber connection drops, the adapter does not resubscribe by itself:
live subscriptions end with a `PubSubConnectionLostError`, so their consumers can
resubscribe and refetch what they missed. A subscription opened while the
connection is down waits for it to come back, and rejects if the client stops
reconnecting.

Any broker can be plugged in through `PubSubAdapter`:

```ts
interface PubSubAdapter {
  publish(channel: string, payload: unknown): Promise<boolean>
  // Resolves once the broker delivers the channel's messages.
  subscribe(
    channel: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<PubSubMessage>>
}
```

## Effect

`@nmtjs/pubsub/effect` needs the optional `effect` peer, pinned to `4.0.0-rc.116`.
Its `defineChannel` takes `effect/Schema` schemas, published through their JSON
encoding, and returns an ordinary channel. The `PubSub` service publishes with an
Effect and subscribes with a Stream that unsubscribes when it ends or its consumer
is interrupted.

```ts
import { defineChannel, layer, PubSub } from '@nmtjs/pubsub/effect'

const room = defineChannel({
  name: 'chat.room',
  params: Schema.Struct({ roomId: Schema.String }),
  key: ({ roomId }) => roomId,
  events: { message: Schema.Struct({ text: Schema.String }) },
})

const program = Effect.gen(function* () {
  const pubsub = yield* PubSub
  yield* pubsub.publish(room.events.message, { roomId }, { text: 'hello' })
  yield* pubsub.subscribe(room, { roomId }).pipe(Stream.runForEach(handle))
})

program.pipe(Effect.provide(layer({ adapter })))
```

Failures are `PubSubError`s carrying the cause, such as the
`PubSubConnectionLostError` that ends a stream when the connection drops. The layer
does not own the adapter; acquire and dispose it in the application's own layer.
