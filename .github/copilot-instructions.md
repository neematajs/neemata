# Neemata Framework - Contributor Guide

## Overview

Neemata is a TypeScript RPC framework with bidirectional streaming, dependency injection, and multi-runtime support. This guide covers internal architecture for contributors.

## Package Architecture

### Dependency Graph

```
                    ┌─────────┐
                    │ common  │  ← Shared utilities (Future, TypeProvider)
                    └────┬────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌────────┐      ┌────────┐      ┌────────┐
    │  core  │      │  type  │      │protocol│
    └────┬───┘      └────────┘      └────┬───┘
         │                               │
         ▼                               ▼
    ┌─────────────────────────────────────────┐
    │                 gateway                 │
    └────────────────────┬────────────────────┘
                         │
                         ▼
    ┌─────────────────────────────────────────┐
    │                 runtime                 │ ← Application lifecycle, workers
    └────────────────────┬────────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        ┌──────────┐          ┌──────────┐
        │ws-transport         │http-transport  ← May include native deps
        └──────────┘          └──────────┘

    ┌─────────────────────────────────────────┐
    │  contract  │  client  │  ws/http-client │ ← User-facing, type inference
    └─────────────────────────────────────────┘
    (contract consumed by client & user apps for types; 
     gateway uses contract interfaces indirectly via runtime)
```

### Package Responsibilities

#### Foundation Layer

- **`common`** - Zero-dependency utilities shared across all packages. Contains `Future`, `TypeProvider`, and helper functions.

- **`core`** - Dependency injection container, scoped lifecycle management (`Global`, `Connection`, `Call`, `Transient`), hooks system, logging, and plugin infrastructure.

- **`type`** - Schema system wrapping `zod/mini` with encode/decode capabilities for protocol serialization.

- **`contract`** - Type-safe API contract definitions (procedures, routers, events). Consumed by client packages and user applications for type inference. Gateway may reference interfaces but doesn't directly depend on it.

#### Protocol Layer

- **`protocol`** - Binary protocol implementation with three entry points via package exports:
  - `@nmtjs/protocol` - Common enums, constants, types (shared by client & server)
  - `@nmtjs/protocol/client` - Client-side encoding/decoding
  - `@nmtjs/protocol/server` - Server-side encoding/decoding
  
  This split enables tree-shaking for client bundles while keeping related code in one package.

- **`json-format`** - JSON serialization format for the protocol. Additional formats (MessagePack, etc.) will follow the same pattern once interfaces stabilize.

#### Server Layer

- **`gateway`** - Connection management, RPC dispatching, and stream handling. Manages the protocol-level communication. **Not intended for standalone use** - should be initialized and managed by runtime.

- **`runtime`** - Application lifecycle, worker management, and server orchestration. This is the main server-side orchestrator that initializes gateway and manages the application.

- **`ws-transport`** / **`http-transport`** - Server-side transport implementations. Separated into distinct packages because they may include heavy dependencies or native binaries, unlike the thin protocol package.

#### Client Layer

- **`client`** - Base client classes and type-safe call infrastructure.

- **`ws-client`** / **`http-client`** - Client-side transport implementations.

#### Infrastructure

- **`proxy`** - Rust-based reverse proxy (Pingora/napi-rs) for production load balancing, rate limiting, and routing traffic between worker threads spawned by runtime/server (moved to separate package due to native binary).

- **`nmtjs`** - CLI and umbrella package. **This is the only package end-users should import from.** Re-exports from underlying packages with a unified API.

## Core Concepts

### Dependency Injection

The DI system in `@nmtjs/core` uses scoped containers with hierarchical resolution.

**Scopes** (defined in `packages/core/src/enums.ts`):
- `Scope.Global` - Singleton, lives for entire application lifetime
- `Scope.Connection` - Per WebSocket/HTTP connection, disposed on disconnect
- `Scope.Call` - Per RPC call, disposed after handler completes
- `Scope.Transient` - New instance on every injection (cannot be retrieved directly)

**Container Hierarchy**: Containers form a parent-child chain (`Global` → `Connection` → `Call`). Resolution walks up the chain to find instances. A scope can only depend on same-or-higher scopes (e.g., `Call` can depend on `Connection`, but not vice versa).

**Injectable Types** (see `packages/core/src/injectables.ts`):
- `LazyInjectable` - Token for late-bound values (via `provide()`)
- `ValueInjectable` - Wraps a static value
- `FactoryInjectable` - Created via factory function, supports `dispose` for cleanup

### Protocol

Binary message protocol with versioning support (see `packages/protocol/src/`).

**Message Types**: Client and server have distinct message enums (`ClientMessageType`, `ServerMessageType`) for RPC calls, responses, and stream control.

**Connection Types**:
- `Bidirectional` - Full duplex (WebSocket), supports server-initiated messages
- `Unidirectional` - Request/response only (HTTP)

**Formats**: Serialization is pluggable via format packages. `json-format` is the reference implementation. Formats handle encoding/decoding of payloads within the binary protocol frame.

### Streams

Two distinct streaming mechanisms exist in the framework:

**Blob Streams** - For arbitrary binary data transfer. Users wrap sources with `ProtocolBlob.from()` helper on both client and server. The framework handles consumption, backpressure, abortions, and timeouts automatically. Blob streams are transported as raw binary chunks outside the format encoding.

**RPC Streams** - For typed, contract-defined data. Procedure handlers return `AsyncIterable` and each yielded value is encoded/decoded according to the contract's output type schema. This enables automatic custom type transformations (dates, etc.) and strong typing for streaming responses.

**Format Integration**: Formats provide encode/decode interfaces that support nested blob detection within RPC payloads. When encoding, formats identify `ProtocolBlob` instances nested anywhere in the payload and extract them for separate streaming. Not all format implementations support this - e.g., `json-format` offers two modes: one with nested blob support (slower due to JS JSON replacer overhead) and one without (faster). Formats like MessagePack can leverage custom encoded types for this naturally.

**Layer Responsibilities**:
- **Protocol** (`packages/protocol/`) - Defines binary message framing for stream control (`*StreamPush`, `*StreamPull`, `*StreamEnd`, `*StreamAbort`)
- **Gateway** (`packages/gateway/`) - Manages stream lifecycle, coordinates between transport and application, handles timeouts
- **Client** (`packages/protocol/src/client/stream.ts`) - Exposes streams via semi-custom interface with backpressure and abort handling

## Development

### Commands

```bash
pnpm build               # Build all packages
pnpm test                # Build + unit tests + runtime tests
pnpm test:unit           # Unit tests only (vitest)
pnpm test:integration    # Integration tests only
pnpm test:watch          # Watch mode
pnpm check               # Format + lint + type-check (required before commit)
pnpm fmt                 # Auto-fix with Biome
```

### Code Style

- Biome: single quotes, no semicolons, 2-space indent
- Imports: Node built-ins → packages → relative (with blank lines between groups)
- Use `import type` with separated style
- Use Node.js import protocol: `import { readFile } from 'node:fs'`
- Explicit `.ts` extensions in relative imports

### Testing

Prefer using `tests` tool for validating test. However, here are the repo commands available:

- **Unit tests**: `packages/*/test/*.spec.ts` - Test individual package functionality (runs with `pnpm test:unit`)
- **Integration tests**: `tests/test/` - Test cross-package interactions (runs with `pnpm test:integration`)

**Shared Test Utilities** (`@nmtjs/_tests` from `tests/src/`):

Common test helpers to reduce boilerplate across packages. Add as dev dependency: `"@nmtjs/_tests": "workspace:*"`

```typescript
import {
  createTestLogger,        // Silent logger for tests
  createTestContainer,     // Container with test logger
  createTestServerFormat,  // BaseServerFormat (JsonFormat)
  createTestClientFormat,  // BaseClientFormat (JsonFormat)
} from '@nmtjs/_tests'
```

- `createTestLogger(options?)` - Creates a silent pino logger (disabled by default)
- `createTestContainer(options?)` - Creates a DI container with test logger
- `createTestServerFormat()` - Returns `BaseServerFormat` for server-side tests
- `createTestClientFormat()` - Returns `BaseClientFormat` for client-side tests

Package-specific mocks (transports, APIs) remain in each package's `test/_mocks/` directory.

### Skill (`skills/use-neemata/`)

The `skills/use-neemata/` directory contains a agent skill that teaches usage of the public Neemata API via the `nmtjs` package. It consists of:

- `SKILL.md` — Main skill definition (triggers, prerequisites, key concepts)
- `references/api-reference.md` — `n.*`, `t.*`, `c.*` function signatures
- `references/rpc.md` — Procedures, routers, streaming, blobs, contracts, guards, middleware, filters
- `references/injectables.md` — DI scopes, injectable builders, `n.inject.*` table
- `references/server-setup.md` — `n.app()`, `n.server()`, `defineConfig()`, project structure
- `references/client-usage.md` — `StaticClient` setup, calls, streams, blobs, abort

**When modifying public APIs**, check whether the skill references need updating:

- Adding/removing/renaming exports from `packages/nmtjs/src/index.ts` → update `references/api-reference.md`
- Changing procedure, router, guard, middleware, filter, or blob APIs → update `references/rpc.md`
- Changing DI scopes, injectable builders, or built-in injectables → update `references/injectables.md`
- Changing `defineApplication`, `defineServer`, `defineConfig`, or project structure conventions → update `references/server-setup.md`
- Changing client classes, transport setup, or call patterns → update `references/client-usage.md`
- Changing imports, architecture overview, or key concepts → update `SKILL.md`

---

**Important**: If during development you notice that implementation deviates from the architecture described in these instructions, explicitly point this out to the user and suggest updating these instructions to reflect the new implementation. **Never modify this file without explicit user consent.** The same applies to the skill files in `skills/use-neemata/` — flag when they become stale and propose updates.