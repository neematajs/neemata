---
title: Client Usage
description: Setting up StaticClient and RuntimeClient, composing connectivity
  plugins, and performing calls, streams, and blob transfers.
---

# Client Usage

## Client Packages

- Base client API, both client classes, shared types, and plugins: `@nmtjs/client`
- Transport implementations: `@nmtjs/ws-client`, `@nmtjs/http-client`
- Client formats: `@nmtjs/json-format/client`, `@nmtjs/msgpack-format/client`

`nmtjs` does **not** currently re-export `StaticClient`, `RuntimeClient`, or the
client transport packages, so client applications should import those directly
from the client packages.

## StaticClient Setup

```ts
import { reconnectPlugin } from '@nmtjs/client'
import { StaticClient } from '@nmtjs/client'
import { WsTransportClient } from '@nmtjs/ws-client'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import type { appContract } from './contracts.ts'

const client = new StaticClient<typeof appContract>(
  {
    contract: appContract,
    protocol: ProtocolVersion.v1,
    format: new JsonFormat(),
    timeout: 5000,
    plugins: [reconnectPlugin()],
  },
  WsTransportClient,
  { url: 'ws://localhost:4000' },
)

await client.connect()
```

- `StaticClient` is proxy-based and resolves procedure paths lazily from property access.
- Use `client.call.*` for non-stream procedures and `client.stream.*` for procedures declared with `stream: true`.

## RuntimeClient Setup

```ts
import { reconnectPlugin } from '@nmtjs/client'
import { RuntimeClient } from '@nmtjs/client'
import { HttpTransportClient } from '@nmtjs/http-client'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import type { appContract } from './contracts.ts'

const client = new RuntimeClient<typeof appContract>(
  {
    contract: appContract,
    protocol: ProtocolVersion.v1,
    format: new JsonFormat(),
    plugins: [reconnectPlugin()],
  },
  HttpTransportClient,
  {
    url: 'http://localhost:4000',
    affinity: {
      // Optional: custom proxy affinity header key
      key: 'session-key-123',
      // Optional: custom header name (default: x-nmt-affinity-key)
      headerName: 'x-nmt-affinity-key',
      // Optional: cookie forwarding mode for proxy sticky cookie
      credentials: 'include',
    },
  },
)
```

- `RuntimeClient` builds callers eagerly and validates encode/decode with contract schemas at runtime.
- Stream procedures are exposed only on `client.stream.*`; non-stream procedures stay on `client.call.*`.

## Connectivity Plugins

Connectivity behavior is fully composed via plugins.

```ts
import {
  browserConnectivityPlugin,
  heartbeatPlugin,
  loggingPlugin,
  reconnectPlugin,
} from '@nmtjs/client'
import { StaticClient } from '@nmtjs/client'
import { WsTransportClient } from '@nmtjs/ws-client'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import type { appContract } from './contracts.ts'

const client = new StaticClient(
  {
    contract: appContract,
    protocol: ProtocolVersion.v1,
    format: new JsonFormat(),
    plugins: [
      reconnectPlugin(),
      browserConnectivityPlugin(),
      heartbeatPlugin({ interval: 15000, timeout: 5000 }),
      loggingPlugin({
        onEvent: (event) => console.log(event),
      }),
    ],
  },
  WsTransportClient,
  { url: 'ws://localhost:4000' },
)
```

- `reconnectPlugin()` — Exponential backoff reconnect loop
- `browserConnectivityPlugin()` — Reconnect nudges on `pageshow`, `online`, `focus`, and `visibilitychange`
- `heartbeatPlugin()` — Ping/Pong liveness checks and reconnect on timeout
- `loggingPlugin()` — Emits structured client events to `onEvent`; message bodies are omitted by default and enabled with `includeBodies: true`

```ts
loggingPlugin({
  onEvent: (event) => {
    sink(event)
  },
}) // includeBodies defaults to false
```

## Plugin Order

Plugin order is deterministic and significant.

- `onInit`, `onConnect`, `onServerMessage`, `onClientEvent` run in registration order.
- `onDisconnect`, `dispose` run in reverse registration order.

Recommended order for connectivity stack:

1. `reconnectPlugin()`
2. `browserConnectivityPlugin()`
3. `heartbeatPlugin()`

This ensures setup flows top-down while teardown flows bottom-up (heartbeat stops before reconnect teardown).

## RPC Calls

```ts
// Type-safe procedure call — returns Promise<Output>
const result = await client.call.greet({ name: 'World' })
// result: { greeting: 'Hello, World!' }
```

## Streaming Calls

```ts
// Returns AsyncIterable<Output>
const stream = await client.stream.liveData({})
for await (const chunk of stream) {
  console.log(chunk) // { value: 0.42 }
}
```

## Abort / Cancel

```ts
const controller = new AbortController()
const promise = client.call.slowOp({}, { signal: controller.signal })
controller.abort() // cancels the call

// Same for streams
const stream = await client.stream.data({}, { signal: controller.signal })
```

## Blob Upload

```ts
const blob = client.blob('file contents', {
  type: 'text/plain',
  filename: 'readme.txt',
})
await client.call.upload({ file: blob })

// client.blob(...) accepts:
//   ReadableStream, File, Blob, string, ArrayBuffer, Uint8Array
```

## Blob Download

```ts
const blob = await client.call.download({ content: 'hello' })

// { type: 'text/plain', size: 12 }
blob.metadata 

// blob has to be called to be consumed, and returns an async iterable of Uint8Array chunks
for await (const chunk of blob()) {
  // process chunk
}
```

## Disconnect

```ts
await client.disconnect()
```

## Migration Note

- Connectivity behavior is plugin-driven.
- Legacy option flags such as autoreconnect and heartbeat are replaced by explicit plugin composition.
