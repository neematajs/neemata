---
title: Client Usage
description: Setting up StaticClient and RuntimeClient, composing connectivity
  plugins, and performing calls, streams, and blob transfers.
---

# Client Usage

## Client Packages

- Base client API, shared types, and plugins: `@nmtjs/client`
- Static proxy client: `@nmtjs/client/static`
- Runtime prebuilt client: `@nmtjs/client/runtime`
- Transport implementations: `@nmtjs/ws-client`, `@nmtjs/http-client`

## StaticClient Setup

```typescript
import { reconnectPlugin } from '@nmtjs/client'
import { StaticClient } from '@nmtjs/client/static'
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

## RuntimeClient Setup

```typescript
import { reconnectPlugin } from '@nmtjs/client'
import { RuntimeClient } from '@nmtjs/client/runtime'
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
  { url: 'http://localhost:4000' },
)
```

- `RuntimeClient` builds callers eagerly and validates encode/decode with contract schemas at runtime.

## Connectivity Plugins

Connectivity behavior is fully composed via plugins.

```typescript
import {
  browserConnectivityPlugin,
  heartbeatPlugin,
  reconnectPlugin,
} from '@nmtjs/client'
import { StaticClient } from '@nmtjs/client/static'
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
    ],
  },
  WsTransportClient,
  { url: 'ws://localhost:4000' },
)
```

- `reconnectPlugin()` — Exponential backoff reconnect loop
- `browserConnectivityPlugin()` — Reconnect nudges on `pageshow`, `online`, `focus`, and `visibilitychange`
- `heartbeatPlugin()` — Ping/Pong liveness checks and reconnect on timeout

## Plugin Order

Plugin order is deterministic and significant.

- `onInit`, `onConnect`, `onServerMessage` run in registration order.
- `onDisconnect`, `dispose` run in reverse registration order.

Recommended order for connectivity stack:

1. `reconnectPlugin()`
2. `browserConnectivityPlugin()`
3. `heartbeatPlugin()`

This ensures setup flows top-down while teardown flows bottom-up (heartbeat stops before reconnect teardown).

## RPC Calls

```typescript
// Type-safe procedure call — returns Promise<Output>
const result = await client.call.greet({ name: 'World' })
// result: { greeting: 'Hello, World!' }
```

## Streaming Calls

```typescript
// Returns AsyncIterable<Output>
const stream = await client.stream.liveData({})
for await (const chunk of stream) {
  console.log(chunk) // { value: 0.42 }
}
```

## Abort / Cancel

```typescript
const controller = new AbortController()
const promise = client.call.slowOp({}, { signal: controller.signal })
controller.abort() // cancels the call

// Same for streams
const stream = await client.stream.data({}, { signal: controller.signal })
```

## Blob Upload

```typescript
import { ProtocolBlob } from '@nmtjs/client'

const blob = ProtocolBlob.from('file contents', {
  type: 'text/plain',
  filename: 'readme.txt',
})
await client.call.upload({ file: blob })

// ProtocolBlob.from() accepts:
//   ReadableStream, File, Blob, string, ArrayBuffer, Uint8Array
```

## Blob Download

```typescript
const blob = await client.call.download({ content: 'hello' })
// blob is an async iterable of Uint8Array chunks
for await (const chunk of blob) {
  // process chunk
}
```

## Disconnect

```typescript
await client.disconnect()
```

## Migration Note

- Connectivity behavior is plugin-driven.
- Legacy option flags such as autoreconnect and heartbeat are replaced by explicit plugin composition.
