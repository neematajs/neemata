---
name: neemata
description: 'Answer questions about the Neemata framework and help build RPC-based applications with bidirectional streaming, dependency injection, and multi-runtime support. Use when developers: (1) Ask about Neemata APIs like n.procedure, n.router, n.app, n.server, n.guard, n.middleware, n.factory, (2) Want to build RPC servers, streaming endpoints, background jobs, or type-safe clients, (3) Have questions about dependency injection scopes, transports (WS/HTTP), contracts, blobs, or the protocol layer, (4) Use the nmtjs package or @nmtjs/* packages. Triggers on: "neemata", "nmtjs", "n.procedure", "n.router", "n.app", "n.server", "createProcedure", "RPC framework", "ProtocolBlob", "t.object", "c.procedure", "n.guard", "n.middleware", "n.factory", "defineApplication", "defineServer", "defineConfig".'
---

## Prerequisites

Before working with a Neemata project, check if `node_modules/nmtjs` exists. If
not, install the `nmtjs` package using the project's package manager (e.g.,
`pnpm add nmtjs`).

Do not install internal `@nmtjs/*` packages directly. The `nmtjs` umbrella
package re-exports everything users need. Transport packages
(`@nmtjs/ws-transport`, `@nmtjs/http-transport`) are separate dependencies for
server-side application definitions only:

```bash
pnpm add nmtjs @nmtjs/ws-transport @nmtjs/http-transport
```

For client-side usage, install:

```bash
pnpm add nmtjs @nmtjs/ws-client    # or @nmtjs/http-client
```

## Finding Documentation

Search source code in `node_modules/nmtjs/`:

- **Public API**: `grep -r "query" node_modules/nmtjs/src/`
- **Core DI**: `grep -r "query" node_modules/@nmtjs/core/src/`
- **Contract types**: `grep -r "query" node_modules/@nmtjs/contract/src/`
- **Type system**: `grep -r "query" node_modules/@nmtjs/type/src/`
- **Protocol**: `grep -r "query" node_modules/@nmtjs/protocol/src/`

## Key Concepts

### Import Convention

All user-facing code should import from `nmtjs`:

```typescript
import { n, t, c, Scope, ErrorCode, ProtocolBlob, ConnectionType } from 'nmtjs'
```

- `n` — Namespace with all builder functions (`n.procedure`, `n.router`, `n.app`, `n.server`, etc.)
- `t` — Type system (wraps zod/mini with encode/decode, e.g., `t.string()`, `t.object()`, `t.date()`)
- `c` — Contract definitions (`c.procedure()`, `c.router()`, `c.event()`, `c.blob()`)
- `Scope` — DI scopes: `Global`, `Connection`, `Call`, `Transient`

### Architecture

Neemata uses a layered architecture:

1. **Config** (`neemata.config.ts`) — defines applications and server entry point via `defineConfig()`
2. **Server** (`n.server()`) — orchestrates workers, proxy, store, metrics
3. **Application** (`n.app()`) — defines transports, router, guards, middleware for one app
4. **Router** (`n.rootRouter()` / `n.router()`) — groups procedures
5. **Procedure** (`n.procedure()`) — individual RPC endpoint with input/output types and handler
6. **Client** (`StaticClient` / `RuntimeClient`) — type-safe RPC calls

### Dependency Injection Scopes

- `Scope.Global` — Singleton, lives for entire app lifetime
- `Scope.Connection` — Per WebSocket/HTTP connection, disposed on disconnect
- `Scope.Call` — Per RPC call, disposed after handler completes
- `Scope.Transient` — New instance on every injection

Containers form a hierarchy: `Global → Connection → Call`. A scope can only depend on same-or-higher scopes.

### Streaming

Two streaming mechanisms:

- **RPC Streams** — Procedure returns `AsyncIterable`, set `stream: true`. Client consumes via `client.stream.*`
- **Blob Streams** — Binary data via `ProtocolBlob.from()` (client) and `createBlob` injectable (server). Use `c.blob()` in contracts

## When Typecheck Fails

1. Check the relevant reference for correct usage:
  - [RPC](references/rpc.md), [Injectables](references/injectables.md),
  - [Server Setup](references/server-setup.md), [Client](references/client-usage.md)
2. Check [API Quick Reference](references/api-reference.md) for correct signatures
3. Search `node_modules/nmtjs/src/` for current type definitions
4. Verify you're importing from `nmtjs` (not internal `@nmtjs/*` packages)

## Project Structure

A typical Neemata project follows this structure:

```
project/
  neemata.config.ts              # defineConfig — app entries + server path
  src/
    index.ts                     # n.server({...}) — server configuration
    applications/
      main/
        index.ts                 # n.app({...}) — application definition
        router.ts                # n.rootRouter([...]) — route tree
        procedures/
          example.ts             # n.procedure({...}) — RPC handlers
        guards/
        middleware/
        injectables/
```

## References

- [API Quick Reference](references/api-reference.md) — Function signatures and options for `n.*`, `t.*`, `c.*` APIs
- [RPC](references/rpc.md) — Procedures, routers, streaming, blobs, contracts, guards, middleware, filters, error handling
- [Injectables](references/injectables.md) — DI scopes, injectable builders (value/lazy/factory), built-in `n.inject.*`
- [Server Setup](references/server-setup.md) — `n.app()`, `n.server()`, `defineConfig()`, project structure
- [Client Usage](references/client-usage.md) — `StaticClient` setup, RPC calls, streams, blobs, abort
- [Jobs](references/jobs.md) — Background jobs, steps, job manager, retry/backoff, progress, job router
