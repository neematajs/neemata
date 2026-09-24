# PubSub

Use `@nmtjs/pubsub` for typed, ephemeral fanout across workers, processes and
servers. Delivery is at most once: no replay, offsets, consumer groups or
disconnected-subscriber recovery. A dropped broker connection ends
subscriptions with `PubSubConnectionLostError`; refetch authoritative state on
resubscription when gaps matter.

## Channels and manager

```ts
import { defineChannel, PubSubManager } from '@nmtjs/pubsub'
import { createRedisAdapter } from '@nmtjs/pubsub/redis'
import { Redis } from 'ioredis'
import * as z from 'zod'

export const rooms = defineChannel({
  name: 'rooms',
  params: z.object({ room: z.string() }),
  key: ({ room }) => room,
  events: {
    message: z.object({ text: z.string() }),
    seen: {
      decode: z.iso.datetime().transform((stored) => new Date(stored)),
      encode: z.date().transform((value) => value.toISOString()),
    },
  },
})

const redis = new Redis('redis://localhost:6379', { lazyConnect: true })
await redis.connect()
const adapter = await createRedisAdapter(redis)
const pubsub = new PubSubManager({ adapter })

await pubsub.publish(rooms.events.message, { room: 'r1' }, { text: 'hello' })
const signal = AbortSignal.timeout(10_000)
const messages = await pubsub.subscribe(
  rooms,
  { room: 'r1' },
  { message: true },
  signal,
)
for await (const { payload } of messages) {
  console.log(payload.text)
}

// Dispose the adapter's subscriber before its caller-owned command client.
await adapter.dispose()
await redis.quit()
```

- `defineChannel({ name, events })` without params takes `undefined` at
  publish/subscribe call sites. A parameterized channel requires both `params`
  and `key`; params are a record of string/number/boolean/null values.
  Validated params determine the broker name:
  `name + ':' + encodeURIComponent(key(params))`.
- Params are synchronous Standard Schemas preserving their input/output type.
  Event payloads are Standard Schemas or `{ decode, encode }` pairs. The
  single-schema check rejects output not assignable to input; use the pair
  when published and application forms differ.
- Shared validation is from `@nmtjs/common`; asynchronous validation throws
  `TypeError`. `PubSubSchemaError` is an alias of its `SchemaError`, with
  `issues` and a message composed from issue paths; its name remains
  `'SchemaError'`.
- `new PubSubManager({ adapter, logger? })` owns neither resource.
  `PubSubLogger` requires `trace`, `debug`, `warn` and `error`, each
  `(obj: unknown, msg?: string) => void`; a Pino logger fits.
- `publish(event, params, payload): Promise<boolean>` validates params and
  encodes payload before calling the adapter. Invalid params/payloads reject.
  An encoded payload that is not plain JSON (a `Date`, `bigint`, `NaN`, class
  instance, sparse array...) rejects with `TypeError`; an absent (`undefined`)
  payload is allowed. Adapter exceptions propagate; a false adapter result
  remains false.
- `subscribe(channel, params, events?, signal?)` resolves to an
  `AsyncIterable` of `{ event, payload }` with decoded, discriminated payloads.
  Omit event selection to receive all events; `{ message: true }` narrows it.
  An explicit empty selection `{}` selects no events at runtime.
- Unknown/unselected events and payload decode failures are logged and skipped.
  Broker/iterator failures end the stream with an error; abort ends it normally.
  Abort or leaving the consumer loop releases the subscription, even before
  the first read. `subscribe()` resolves once the broker subscription is live:
  a message published after it resolves is delivered. A failed broker
  subscription rejects it.

## Redis / Valkey adapter

`@nmtjs/pubsub/redis` exports `RedisPubSubAdapter`, `createRedisAdapter`
and `RedisPubSubClient` (`ioredis.Redis | iovalkey.Redis`).

- Pass an already connected command client. The factory awaits
  `initialize()`; direct construction with `new RedisPubSubAdapter(client,
logger?)` requires calling `initialize()` yourself before subscriptions.
- Each adapter instance duplicates the command client with
  `{ lazyConnect: true }` and driver resubscribe, command resend and the
  offline queue turned off, connects that one subscriber, and shares it across
  channels/local listeners. Channel subscriptions are reference-counted, with
  SUBSCRIBE/UNSUBSCRIBE serialized per channel; a failed SUBSCRIBE is retried
  by the next subscriber. A SUBSCRIBE that failed without a broker reply (a
  `commandTimeout`) is followed, best effort, by an UNSUBSCRIBE on the same
  connection, which the broker runs after a late SUBSCRIBE and before any
  retry; if that UNSUBSCRIBE is itself rejected, a warning is logged and the
  broker subscription may remain until the connection closes. This is not a
  process-global singleton. Reuse an adapter to share connections.
- When the subscriber connection drops, the adapter does not resubscribe:
  established subscriptions end with `PubSubConnectionLostError` (exported by
  `@nmtjs/pubsub` and `@nmtjs/pubsub/effect`) ahead of their unread backlog; a
  manager stream may still yield a message or two it had read ahead.
  Resubscribe and refetch on it. A subscription opened while the connection is
  down waits for it (bounded only by an abort signal) and rejects once the
  client stops reconnecting; one whose SUBSCRIBE was in flight at the drop
  rejects with `PubSubConnectionLostError`. Releases never wait on a
  connection that is down.
- `dispose()` ends live subscriptions cleanly (streams end, no error; pending
  openings reject with an `AbortError`), removes local listeners and
  disconnects the duplicate only, without waiting on a connection that is
  down. The caller must close its original client afterward. Neither
  `PubSubManager` nor the Effect layer calls adapter disposal.
- Messages are JSON-serialized. Malformed incoming JSON is logged and skipped.
- Redis publish returns true when the broker command succeeds, even with zero
  subscribers; serialization/broker failures return false. `true` is not a
  delivery receipt.
- The Redis adapter buffers events for a slow subscriber without bound; there
  is no overflow policy.

Other brokers implement `PubSubAdapter`:
`publish(channel: string, payload: unknown): Promise<boolean>` and
`subscribe(channel: string, signal?: AbortSignal): Promise<AsyncIterable<PubSubMessage>>`,
resolving once the broker delivers the channel's messages.
A `PubSubMessage` is `{ channel, data: { event, payload } }`. Honor abort so
idle subscriptions, including ones never read, can be released.

## Effect

`@nmtjs/pubsub/effect` requires the optional peer `effect` exactly
`4.0.0-rc.116`. It exports `defineChannel`, `PubSub`, `PubSubError`,
`make`, `layer`, and `codec` / `schemaOf` from `@nmtjs/common/effect`.

```ts
import {
  defineChannel as defineEffectChannel,
  layer,
  PubSub,
} from '@nmtjs/pubsub/effect'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

const updates = defineEffectChannel({
  name: 'updates',
  events: { changed: Schema.Struct({ id: Schema.String }) },
})
const publishUpdate = Effect.gen(function* () {
  const service = yield* PubSub
  return yield* service.publish(updates.events.changed, undefined, { id: 'd1' })
})
// Supply an adapter whose application-owned lifetime covers this Effect.
function providePubSub(adapter: Parameters<typeof layer>[0]['adapter']) {
  return publishUpdate.pipe(Effect.provide(layer({ adapter })))
}
```

Effect channels use synchronous, service-free Effect schemas and their JSON
encoding, returning ordinary channels usable by either manager. Parameter
schemas must preserve the parameter type. `schemaOf` returns the original
Effect schema only for a codec made through `codec`.

`make({ adapter, logger? })` returns `PubSub['Service']` directly.
`layer({ adapter, logger? })` provides that service without acquiring or
disposing the adapter. Own its lifetime in the application.

The service's `publish` returns `Effect<boolean, PubSubError>`;
`subscribe(channel, params, events?)` returns a
`Stream<SelectedEventUnion, PubSubError>` with scope/interruption cleanup
(no explicit signal parameter). Raised failures carry `PubSubError` with
`_tag: 'PubSubError'` and `cause`; a Redis adapter's false publish result
stays a successful false Effect. Decode failures remain logged/skipped.
