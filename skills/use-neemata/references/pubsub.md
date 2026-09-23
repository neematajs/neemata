# PubSub

Use `@nmtjs/pubsub` for ephemeral typed fanout and live state notifications across
workers, processes and servers. It delivers at most once: no consumer groups,
replay, offsets, or recovery. Subscribers that cannot tolerate a gap refetch state
when they resubscribe.

```ts
import { defineChannel, PubSubManager } from '@nmtjs/pubsub'
import { createRedisAdapter } from '@nmtjs/pubsub/redis'
import * as z from 'zod'

export const rooms = defineChannel({
  name: 'rooms',
  params: z.object({ room: z.string() }),
  key: ({ room }) => room,
  events: { message: z.object({ text: z.string() }) },
})

const adapter = await createRedisAdapter(redisClient) // ioredis or iovalkey
const pubsub = new PubSubManager({ adapter, logger })

await pubsub.publish(rooms.events.message, { room }, { text })

const stream = await pubsub.subscribe(
  rooms,
  { room },
  { message: true },
  signal,
)
for await (const { event, payload } of stream) {
  // payload: { text: string }
}
```

## Rules

- Schemas are Standard Schemas and must validate synchronously. A payload with a
  different published form declares `{ decode, encode }`; a lone transforming schema
  is a compile error.
- `publish(event, params, payload)` validates and encodes, then returns
  `Promise<boolean>`. A channel without params takes `undefined`.
- `subscribe(channel, params, events?, signal?)` returns an async iterable of
  decoded events. Pass a selection such as `{ message: true }` to narrow it.
- Unknown events and undecodable payloads are logged and skipped.
- The Redis adapter shares one subscriber connection per process. It does not own
  the client: `await adapter.dispose()` before closing it.
- Other brokers implement `PubSubAdapter` (`publish`, `subscribe`).

## Effect

```ts
import { defineChannel, layer, PubSub } from '@nmtjs/pubsub/effect'
```

`defineChannel` takes `effect/Schema` schemas and returns an ordinary channel.
`PubSub` is a service: `publish` returns an Effect, `subscribe` returns a Stream
that unsubscribes when it ends or is interrupted; both fail with `PubSubError`.
`layer({ adapter, logger })` provides it and does not own the adapter. Serving a
subscription to a client is application code: return the Stream from an Effect RPC
streaming procedure.
