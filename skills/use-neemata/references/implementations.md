# Implementations

Implementation APIs bind handlers to public contracts. Use them when route
names must stay stable or client/server packages share API shape.

## Direct Contract Procedures, Streams, And Routers

```ts
import { c, contractProcedure, contractStream, contractRouter, t } from 'nmtjs'

const usersContract = c.router({
  routes: {
    get: c.procedure({
      input: t.object({ id: t.string() }),
      output: t.object({ name: t.string() }),
    }),
    watch: c.stream({
      input: t.object({ organizationId: t.string() }),
      output: t.object({ id: t.string() }),
    }),
  },
})

export const usersRouter = contractRouter(usersContract, {
  routes: {
    get: contractProcedure(usersContract.routes.get, (_ctx, input) => {
      return { name: input.id }
    }),
    watch: contractStream(usersContract.routes.watch, {
      streamTimeout: 30_000,
      async *handler(_ctx, input) {
        yield { id: input.organizationId }
      },
    }),
  },
})
```

Rules:

- `contractProcedure(contract, handler | options)` binds one procedure
  contract to a handler.
- `contractStream(contract, handler | options)` binds one stream contract to an
  async-iterable handler. Only stream implementations accept `streamTimeout`.
- `contractRouter(contract, { routes, ... })` binds one router contract to
  route implementations.
- Route implementations must match the contract keys and nested contracts.

## Callable `implementRouter(...)`

`implementRouter(...)` mirrors nested contract topology with callable builders.
Use the `nmtjs` umbrella export.

```ts
import { c, implementRouter, inject, t } from 'nmtjs'

const contract = c.router({
  routes: {
    users: c.router({
      routes: {
        list: c.procedure({
          input: t.object({ organizationId: t.string() }),
          output: t.object({ ids: t.array(t.string()) }),
        }),
      },
    }),
    health: c.procedure({
      output: t.object({ ok: t.boolean() }),
    }),
  },
})

const api = implementRouter(contract)

export const router = api({
  users: api.users({
    list: api.users.list({
      dependencies: { logger: inject.logger },
      handler: ({ logger }, input) => {
        logger.info({ organizationId: input.organizationId }, 'listing users')
        return { ids: [] }
      },
    }),
  }),
  health: api.health(() => ({ ok: true })),
})
```

Rules:

- `implementRouter(routerContract)` returns a root router implementer.
- `implementRouter(procedureContract)` returns a procedure implementer;
  `implementRouter(streamContract)` returns a stream implementer.
- Router builders validate missing, unknown, and mismatched route
  implementations.
- Procedure and stream builders accept either a handler or full options with
  `dependencies`, `guards`, `middlewares`, `meta`, and `handler`; stream
  builders additionally accept `streamTimeout`.
- Dependencies stay explicit. Request `inject.logger` when a handler needs a
  logger.

## When Not To Use

- For local-only APIs with no shared contract package, `procedure(...)` and
  `router(...)` are shorter and infer contracts from implementation.
- For pubsub delivery, define shared subscription contracts first, then
  use the delivery-specific APIs.
