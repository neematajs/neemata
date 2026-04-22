---
title: Dependency Injection
description: DI scopes, injectable builders (value, lazy, factory), and built-in
  injectables available via n.inject.
---

# Dependency Injection

## Scopes

Neemata DI uses scoped containers with hierarchical resolution:

- `Scope.Global` — Singleton, lives for entire app lifetime
- `Scope.Connection` — Per WebSocket/HTTP connection, disposed on disconnect
- `Scope.Call` — Per RPC call, disposed after handler completes
- `Scope.Transient` — New instance on every injection (cannot be retrieved directly)

Containers form a hierarchy: `Global → Connection → Call`. A scope can only depend on same-or-higher scopes (e.g., `Call` can depend on `Connection`, but not vice versa).

## Injectable Builders

```ts
import { n, Scope } from 'nmtjs'

// Static value — wraps a constant
const configInjectable = n.value({ apiUrl: 'https://api.example.com' })

// Lazy — token for late-bound values (resolved via container.provide())
const identityToken = n.lazy<string>(Scope.Connection)

// Factory — created via factory function with DI, scope, and cleanup
const serviceInjectable = n.factory({
  dependencies: { config: configInjectable, logger: n.inject.logger },
  scope: Scope.Global,
  factory: ({ config, logger }) => new MyService(config, logger),
  dispose: (service) => service.shutdown(),
})
```

### `n.lazy` pattern: define once, provide at runtime

`n.lazy` is useful when a value is only known during request processing. Common
flow:

1. Define a lazy token (usually in a shared `injectables.ts` file)
2. Provide a concrete value from middleware/hook/transport integration
3. Inject and use it in procedures via `dependencies`

```ts
import { randomUUID } from 'node:crypto'

import { n, Scope, t } from 'nmtjs'

// 1) Define a token once
export const requestId = n.lazy<string>(Scope.Call)

// 2) Provide it at runtime from middleware
export const requestIdMiddleware = n.middleware({
  handle: async (_, call, next) => {
    const value = randomUUID()
    call.container.provide(requestId, value)
    return next()
  },
})

// 3) Consume it in procedures
export const echoProcedure = n.procedure({
  dependencies: { requestId, logger: n.inject.logger('echo') },
  input: t.object({ message: t.string() }),
  output: t.object({ requestId: t.string(), message: t.string() }),
  handler: ({ requestId, logger }, input) => {
    logger.info({ requestId }, 'Request received')
    return { requestId, message: input.message }
  },
})
```

Middleware is a good place to provide call-scoped values like correlation IDs.
It runs before guards and handlers and operates on the raw request payload.

If a lazy token may be absent, inject it as optional in dependencies using
`myLazy.optional()`.

## Built-in Injectables (`n.inject.*`)

| Injectable | Scope | Type | What it is | When to use |
|---|---|---|---|---|
| `n.inject.logger` | Global | `Logger` | Base app logger instance | Default logging in guards, middleware, procedures, and jobs |
| `n.inject.logger('label')` | Global | `Logger` | Child logger with label context | Prefer for component-specific logs (e.g. `logger('auth')`) |
| `n.inject.inject` | Global | Function | Imperative DI resolver for current container | Advanced/infrastructure scenarios; prefer declarative `dependencies` |
| `n.inject.dispose` | Global | Function | Imperative disposal helper for container-managed values | Infrastructure/plugins; avoid in regular request handlers |
| `n.inject.connection` | Connection | `GatewayConnection` | Full connection object (id, type, identity, transport, protocol context) | When you need low-level connection details beyond metadata |
| `n.inject.connectionId` | Connection | `string` | Stable current connection identifier | Correlation IDs, metrics labels, per-connection caches/maps |
| `n.inject.connectionData` | Connection | `unknown` | Transport-provided request/connection context | Auth/session/user/request metadata propagated from transport |
| `n.inject.connectionAbortSignal` | Connection | `AbortSignal` | Signal aborted when connection is closed/disconnected | Cancel long-running work tied to connection lifetime |
| `n.inject.rpcClientAbortSignal` | Call | `AbortSignal` | Base per-call cancellation signal from client/request side | Use only if you specifically need the pre-composed call signal before framework-level composition |
| `n.inject.rpcStreamAbortSignal` | Call | `AbortSignal` | Optional stream-timeout signal | Only available when the procedure uses a timed stream configuration such as `stream: 5_000` |
| `n.inject.rpcAbortSignal` | Call | `AbortSignal` | Unified call signal resolved from client/request + connection + optional stream timeout | Recommended default signal for handler cancellation checks |
| `n.inject.createBlob` | Call | Function | Factory that wraps data source into protocol blob response | Server-to-client binary streaming/blob responses |
| `n.inject.consumeBlob` | Call | Function | Converts an incoming blob marker from request payload into a readable stream | Client-to-server blob uploads that handlers want to consume explicitly; ignored upload blobs are aborted when the handler completes |

### Cancellation signal quick guide

- Use `n.inject.rpcAbortSignal` by default in procedure handlers.
- `n.inject.rpcClientAbortSignal` is the base per-call signal provided by the gateway; most handlers should prefer `n.inject.rpcAbortSignal`.
- Use `n.inject.connectionAbortSignal` when work should survive call boundaries but stop on disconnect.
- Use `n.inject.rpcStreamAbortSignal` only in stream procedures with an explicit timed stream configuration (for example `stream: 5_000`).
- Plain `stream: true` is fully valid for stream procedures; it simply means there is no custom per-procedure stream timeout, so `n.inject.rpcStreamAbortSignal` is not provided.
- Avoid requiring `n.inject.rpcStreamAbortSignal` in generic procedures because it is optional by design.

## Using Injectables in Procedures

Pass injectables via the `dependencies` option — they are resolved and injected as the first argument to the handler:

```ts
import { n, t } from 'nmtjs'

export const profileProcedure = n.procedure({
  dependencies: {
    connectionData: n.inject.connectionData,
    signal: n.inject.rpcAbortSignal,
    logger: n.inject.logger('profile'),
  },
  input: t.object({}),
  output: t.object({ userId: t.string() }),
  handler: ({ connectionData, signal, logger }) => {
    logger.info('Fetching profile')
    return { userId: connectionData.userId }
  },
})
```
