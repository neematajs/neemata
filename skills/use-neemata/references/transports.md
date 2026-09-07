# Transports

One HTTP server (the "server transport") owns a listen address; protocol
handlers mount onto it by path. Handlers are constructed with protocol-level
options and receive per-mount options through the transport factory's
`handlers` record (usually supplied by the Neem planner).

```ts
import { createServerTransport } from '@nmtjs/transports/http-server'
import { createServerHost } from '@nmtjs/transports/http-server/node'
import { jsonRpc } from '@nmtjs/transports/json-rpc'
import { mcp } from '@nmtjs/transports/mcp'
import { neemataHttp } from '@nmtjs/transports/neemata/http'
import { neemataWebSocket } from '@nmtjs/transports/neemata/ws'
import { JsonCodec } from '@nmtjs/protocol/json/server'
import { ProtocolCodecRegistry } from '@nmtjs/protocol/server'

const codecs = new ProtocolCodecRegistry([new JsonCodec()])

export const Server = createServerTransport({
  host: createServerHost, // or http-server/bun, http-server/deno
  handlers: {
    api: neemataHttp({ codecs }),
    ws: neemataWebSocket({ codecs }),
    rpc: jsonRpc(),
    agents: mcp(),
  },
})
```

Per-mount options (planner/factory side; keys match the `handlers` record):

```ts
{
  listen: { hostname: '127.0.0.1', port: 4000 },
  handlers: {
    api: { path: '/' },
    ws: { path: '/ws' },
    rpc: { path: '/jsonrpc' },
    agents: {
      path: '/mcp',
      serverInfo: { name: 'my-app', version: '1.0.0' },
      tools: [{ procedure: 'users/create' }],
    },
  },
}
```

Host-level options next to `listen`: `tls`, `maxRequestBodySize` (default
128MiB; handlers may only tighten it), `webSocket` (runtime-wide WS behavior),
`runtime` (runtime-specific server options).

## Native Handlers (Neemata Protocol)

`neemataHttp({ codecs })` and `neemataWebSocket({ codecs })` serve the
first-party protocol for `@nmtjs/client` transports. `codecs` is a required
`ProtocolCodecRegistry`; the handler negotiates encoder/decoder per
request/upgrade from `Accept`/`Content-Type` (WS clients pass them as
`accept`/`content-type` query params). The first registry codec is the
default.

`neemataHttp` per-mount options:

- `path` - mount prefix; procedure names are the remaining path segments.
- `cors` - `true`, an origin allowlist, an options object, or a function.
  `true` reflects any origin without credentials; explicit allowlists enable
  credentials.
- `maxRequestBodySize` - stricter cap than the host limit.

Behavior notes:

- Procedures allow POST by default; attach the `AllowedHttpMethod` static
  meta (from `@nmtjs/transports/neemata/http`) to allow `get`, `put`, etc.
- GET calls read input from the `?payload=<json>` query param.
- A request body with an undecodable content-type (or the `X-Neemata-Blob`
  header) is passed to the procedure as a blob stream payload.
- Provision `httpResponseHeaders` (call-scoped injectable from
  `@nmtjs/transports/neemata/http`) to set response headers from handlers.
- Stream procedures respond as SSE; blob results stream as the response body.

`neemataWebSocket` per-mount options:

- `path` - upgrade path.
- `heartbeat` - `false` or `{ interval?, timeout? }` (defaults 15s/5s);
  server-initiated protocol Ping/Pong, a missed Pong closes the socket.
- `streamIdleTimeout` - per-stream peer-inactivity bound (default 30s).

WebSocket is the only transport with full duplex features. RPC response streams
use client-configurable chunk-credit windows; blob uploads and downloads use an
automatic 1 MiB byte-credit window with 512 KiB refills and frames capped at
64 KiB. The receiver grants credit before data is sent, and each peer rejects
data beyond the outstanding grant. Blob window/refill values are protocol
defaults and are not `neemataWebSocket` options. See
[Client Usage](client-usage.md#flow-control) for the public RPC configuration.

## JSON-RPC 2.0

`jsonRpc()` projects unary procedures as a standard JSON-RPC 2.0 endpoint
(single requests, batches, notifications). Method names are the native
procedure names with `/` replaced by `.` (`users/create` → `users.create`);
no renaming exists. Stream procedures are not projected.

Per-mount options: `path`, `maxBatchSize` (default 100),
`maxRequestBodySize`, `include`/`exclude` (native-name patterns: exact,
`users/*` subtree, or `*`; `exclude` applies after `include`).

Encoding is plain JSON owned by the handler — native codecs are not
involved. Protocol errors map to JSON-RPC error codes with the native code
preserved in `error.data.code`.

## MCP

`mcp()` (from `@nmtjs/transports/mcp`, requires the optional
`@modelcontextprotocol/server` peer dependency) exposes a curated set of
unary procedures as MCP tools. Stateless, MCP spec 2026-07-28 only; older
protocol revisions are rejected.

Per-mount options:

- `serverInfo` - `{ name, version, title? }`.
- `instructions` - optional usage instructions surfaced to clients.
- `tools` - array of `{ procedure, name?, title?, description?,
annotations? }`. Tool names default to the native name with `/` → `_`.
  A description is required — on the tool config or the procedure contract.
  Input schemas are derived from the procedure's input contract.
- `auth` - bearer-token authorization: `{ verifier, requiredScopes?,
resourceMetadataUrl?, protectedResourceMetadata? }`. With
  `protectedResourceMetadata` set, the handler also serves
  `/.well-known/oauth-protected-resource`. With better-auth 1.7+, implement
  `verifier` over `@better-auth/mcp`.

When `auth` is configured, the verified token is available to procedures via
the connection-scoped `mcpAuthInfo` injectable from
`@nmtjs/transports/mcp`.

## Projection Rules

- Projections never invent names: every public name is a deterministic
  transform of the native procedure name (native `/`, JSON-RPC `.`, MCP `_`).
- Blob and stream capabilities are transport-owned: native WS supports all of
  them, native HTTP supports blob bodies and SSE streams, JSON-RPC and MCP
  are unary-only and provide no blob injectables.
