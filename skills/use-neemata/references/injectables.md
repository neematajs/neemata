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

```typescript
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

```typescript
import { randomUUID } from 'node:crypto'

import { n, Scope, t } from 'nmtjs'

// 1) Define a token once
export const requestId = n.lazy<string>(Scope.Call)

// 2) Provide it at runtime from middleware
export const requestIdMiddleware = n.middleware({
  handle: async (_, call, next, payload) => {
    const value = randomUUID()
    call.container.provide(requestId, value)
    return next(payload)
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
| `n.inject.rpcClientAbortSignal` | Call | `AbortSignal` | Per-call cancellation from client/request side | Use only if you specifically need client/request-originated cancellation |
| `n.inject.rpcStreamAbortSignal` | Call | `AbortSignal` | Optional stream-timeout signal | Only available when procedure sets `streamTimeout` |
| `n.inject.rpcAbortSignal` | Call | `AbortSignal` | Unified call signal (client/request + connection + optional stream timeout) | Recommended default signal for handler cancellation checks |
| `n.inject.createBlob` | Call | Function | Factory that wraps data source into protocol blob response | Server-to-client binary streaming/blob responses |

### Cancellation signal quick guide

- Use `n.inject.rpcAbortSignal` by default in procedure handlers.
- Use `n.inject.connectionAbortSignal` when work should survive call boundaries but stop on disconnect.
- Use `n.inject.rpcStreamAbortSignal` only in stream procedures with explicit `streamTimeout`.
- Avoid requiring `n.inject.rpcStreamAbortSignal` in generic procedures because it is optional by design.

## Using Injectables in Procedures

Pass injectables via the `dependencies` option — they are resolved and injected as the first argument to the handler:

```typescript
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
