# PubSub

Use pubsub for ephemeral typed fanout and live state notifications. Pubsub
delivers subscription contracts with async iterables; it does not provide
consumer groups, replay, offsets, or recovery.

```ts
import { inject, procedure, t } from 'nmtjs'
import { rooms } from './subscriptions.ts'

export const publishMessage = procedure({
  dependencies: { publish: inject.publish },
  input: t.object({ room: t.string(), text: t.string() }),
  output: t.object({ ok: t.boolean() }),
  async handler({ publish }, input) {
    const ok = await publish(
      rooms.events.message,
      { room: input.room },
      { text: input.text },
    )
    return { ok }
  },
})
```

```ts
import { inject, procedure, t } from 'nmtjs'
import { rooms } from './subscriptions.ts'

export const subscribeRoom = procedure({
  dependencies: { subscribe: inject.subscribe },
  input: t.object({ room: t.string() }),
  output: t.object({ event: t.string(), text: t.string() }),
  stream: true,
  async *handler({ subscribe }, input) {
    const stream = await subscribe(
      rooms,
      { room: input.room },
      { message: true },
    )
    for await (const event of stream) {
      yield { event: event.event, text: event.payload.text }
    }
  },
})
```

## Rules

- `publish(event, params, payload)` publishes one subscription event and returns
  `Promise<boolean>`.
- `subscribe(subscription, params, events?, signal?)` returns an async iterable
  of decoded selected events.
- Pass an event selection object such as `{ message: true }` to narrow stream
  output.
- Use pubsub for low-latency live fanout where missed messages are acceptable.

## Plugin And Adapter

Plugins and adapters use package subpaths:

```ts
import { pubsubPlugin } from 'nmtjs'
import { createRedisAdapter } from '@nmtjs/pubsub/redis'

pubsubPlugin({ adapter: createRedisAdapter(redisClient) })
```
