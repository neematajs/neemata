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

## Built-in Injectables (`n.inject.*`)

| Injectable | Scope | Type | Description |
|---|---|---|---|
| `n.inject.logger` | Global | `Logger` | Pino logger instance |
| `n.inject.logger('label')` | Global | `Logger` | Labeled logger |
| `n.inject.inject` | Global | Function | DI inject function |
| `n.inject.dispose` | Global | Function | DI dispose function |
| `n.inject.connection` | Connection | `GatewayConnection` | Connection object |
| `n.inject.connectionId` | Connection | `string` | Connection ID |
| `n.inject.connectionData` | Connection | `unknown` | Auth/metadata |
| `n.inject.connectionAbortSignal` | Connection | `AbortSignal` | Connection lifetime signal |
| `n.inject.rpcClientAbortSignal` | Call | `AbortSignal` | Client-initiated abort |
| `n.inject.rpcStreamAbortSignal` | Call | `AbortSignal` | Stream timeout abort |
| `n.inject.rpcAbortSignal` | Call | `AbortSignal` | Combined abort signal |
| `n.inject.createBlob` | Call | Function | Blob factory for responses |

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
