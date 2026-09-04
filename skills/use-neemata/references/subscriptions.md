# Subscription Contracts

Use `c.subscription(...)` for a named stream/channel family carrying related
typed events. This is shared contract model, not delivery behavior.

```ts
import { c, t } from 'nmtjs'

export const users = c.subscription({
  namespace: 'users',
  params: t.object({ organizationId: t.string() }).decode,
  key: ({ organizationId }) => organizationId,
  events: {
    created: c.event({ payload: t.object({ id: t.string() }) }),
    renamed: c.event({
      payload: t.object({ id: t.string(), name: t.string() }),
    }),
  },
})
```

## Concepts

- `namespace` names the logical stream/channel family.
- `params` is a one-way Standard Schema used to identify one concrete
  stream/channel. Publish and subscribe accept its input; `key(params)` receives
  its validated/transformed output. Use `.decode` when selecting that direction
  from a `t.*` codec.
- `key(params)` derives the adapter key string within the namespace.
- `events` is the typed event map carried by the subscription.
- Event payloads are encoded on publish/produce and decoded in handlers or
  subscribers, so present payloads must be full codecs.
- `c.subscription(...)` attaches `event` name and parent `subscription` to each
  event contract.

## Boundary

- Pubsub delivers subscription events ephemerally with async iterables.
