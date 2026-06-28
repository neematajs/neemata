# Subscription Contracts

Use `c.subscription(...)` for a named stream/channel family carrying related
typed events. This is shared contract model, not delivery behavior.

```ts
import { c, t } from 'nmtjs'

export const users = c.subscription({
  namespace: 'users',
  params: t.object({ organizationId: t.string() }),
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
- `params` is decoded input used to identify one concrete stream/channel. If
  `params` exists, `key(params)` is required.
- `key(params)` derives the adapter key string within the namespace.
- `events` is the typed event map carried by the subscription.
- Event payloads are encoded on publish/produce and decoded in handlers or
  subscribers.
- `c.subscription(...)` attaches `event` name and parent `subscription` to each
  event contract.

## Boundary

- Pubsub delivers subscription events ephemerally with async iterables.
- Eventing consumes subscription events durably with consumer groups, offsets,
  replay, retry, and dead-letter policy.
