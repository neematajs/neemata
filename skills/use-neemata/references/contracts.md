# Contracts

Contracts describe public API shape independent of handler implementation.
They are shared by servers, clients, pubsub, and tooling.

```ts
import { c, t } from 'nmtjs'
```

## RPC Contracts

```ts
export const users = c.router({
  routes: {
    list: c.procedure({
      input: t.object({ organizationId: t.string() }),
      output: t.object({ ids: t.array(t.string()) }),
    }),
    stream: c.procedure({
      input: t.object({ organizationId: t.string() }),
      output: t.object({ id: t.string() }),
      stream: true,
    }),
  },
})
```

Rules:

- `c.procedure(...)` defaults missing `input` and `output` to `t.never()`.
- `stream: true` marks the route as a stream contract. Numeric stream timeouts
  are implementation behavior, not public contract shape.
- `timeout` is contract metadata and can be inherited through routers.
- Router route keys become path segments and typed client property names.
- Child names are recomputed from route keys. Router `name` is not a mount
  prefix once composed under a parent key.
- Renaming a route key is a public API breaking change.

## Event Contracts

```ts
export const userCreated = c.event({
  payload: t.object({ id: t.string(), email: t.string().email() }),
})
```

Event contracts describe one named payload shape once attached to a
subscription. Payloads are encoded at publish/produce boundaries and decoded at
subscribe/consume boundaries.

## Subscription Contracts

```ts
export const userEvents = c.subscription({
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

Rules:

- `namespace` names the logical stream/channel family.
- `params` identifies one concrete stream/channel instance. If `params` is
  present, `key(params)` is required and returns adapter key string.
- `events` becomes a typed event map. Each event gets its event name and parent
  subscription attached by `c.subscription(...)`.
- The same subscription contract powers pubsub delivery.

## Blob Contracts

```ts
import { blobType, c, t } from 'nmtjs'

const fileContract = c.procedure({
  input: t.object({ file: blobType() }),
  output: blobType(),
})
```

`blobType()` marks protocol blob fields. Server/client code must explicitly create
or consume blob streams at runtime; contract only records transport shape.
