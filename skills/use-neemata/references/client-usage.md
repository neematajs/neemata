# Client Usage

## Client Setup

- Base client API, both client classes, shared types, and plugins: `@nmtjs/client`
- Transport implementations: `@nmtjs/client/ws`, `@nmtjs/client/http`
- Client codecs: `@nmtjs/protocol/json/client`, `@nmtjs/protocol/msgpack/client`

## StaticClient Setup

```ts
import { reconnectPlugin } from '@nmtjs/client'
import { StaticClient } from '@nmtjs/client'
import { WsTransportFactory } from '@nmtjs/client/ws'
import { JsonCodec } from '@nmtjs/protocol/json/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { appContract } from './contracts.ts'

const client = new StaticClient<typeof appContract>(
  {
    contract: appContract,
    protocol: ProtocolVersion.v1,
    codec: new JsonCodec(),
    autoConnect: true,
    timeout: 5000,
    plugins: [reconnectPlugin()],
  },
  WsTransportFactory,
  { url: 'ws://localhost:4000' },
)
```

- `StaticClient` is proxy-based and resolves procedure paths lazily from property access.
- `autoConnect: true` lets the client connect on the first call/stream instead of requiring an explicit `await client.connect()`.
- After an explicit `await client.disconnect()`, implicit reconnection is suppressed until you connect again manually.
- Use `client.call.*` for `procedure({ ... })` routes and `client.stream.*` for routes declared with `stream({ ... })`.

## RuntimeClient Setup

```ts
import { reconnectPlugin } from '@nmtjs/client'
import { RuntimeClient } from '@nmtjs/client'
import { HttpTransportFactory } from '@nmtjs/client/http'
import { JsonCodec } from '@nmtjs/protocol/json/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { appContract } from './contracts.ts'

const client = new RuntimeClient<typeof appContract>(
  {
    contract: appContract,
    protocol: ProtocolVersion.v1,
    codec: new JsonCodec(),
    autoConnect: true,
    plugins: [reconnectPlugin()],
  },
  HttpTransportFactory,
  { url: 'http://localhost:4000' },
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
import { WsTransportFactory } from '@nmtjs/client/ws'
import { JsonCodec } from '@nmtjs/protocol/json/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { appContract } from './contracts.ts'

const client = new StaticClient(
  {
    contract: appContract,
    protocol: ProtocolVersion.v1,
    codec: new JsonCodec(),
    plugins: [
      reconnectPlugin(),
      browserConnectivityPlugin(),
      heartbeatPlugin({ interval: 15000, timeout: 5000 }),
      loggingPlugin({
        onEvent: (event) => console.log(event),
      }),
    ],
  },
  WsTransportFactory,
  { url: 'ws://localhost:4000' },
)
```

- `reconnectPlugin()` - exponential backoff reconnect loop.
- `browserConnectivityPlugin()` - reconnect nudges on `pageshow`, `online`,
  `focus`, and `visibilitychange`.
- `heartbeatPlugin()` - ping/pong liveness checks and reconnect on timeout.
- `loggingPlugin()` - emits structured client events to `onEvent`; message
  bodies are omitted by default and enabled with `includeBodies: true`.

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
// Type-safe procedure call; returns Promise<Output>
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

## Flow Control

Native WebSocket RPC streams use receiver-issued chunk credits. Configure the
default client window with `backpressure.rpc.window`:

```ts
const client = new StaticClient<typeof appContract>(
  {
    contract: appContract,
    protocol: ProtocolVersion.v1,
    codec: new JsonCodec(),
    backpressure: {
      rpc: { window: 16 },
    },
  },
  WsTransportFactory,
  { url: 'ws://localhost:4000' },
)
```

Override that default for one streaming call when its chunk size or consumer
behavior warrants a different bound:

```ts
const stream = await client.stream.liveData(
  {},
  { backpressure: { rpc: { window: 32 } } },
)
```

- The default RPC window is 16 and must be a positive uint32 integer.
- RPC credits count chunks, not bytes. The window bounds how far a WebSocket
  producer may advance ahead of its consumer, including side effects performed
  while producing chunks.
- Larger windows may hide more network latency, but proportionally allow more
  queued data and speculative producer progress. Unidirectional transports use
  their native stream backpressure instead.
- Native WebSocket blob uploads and downloads use automatic byte-credit flow
  control: a 1 MiB window, refilled after 512 KiB is consumed, with frames
  capped at 64 KiB. These values are currently protocol defaults, not public
  client or per-call options; do not invent `backpressure.blob`.
- The receiver grants credit before the sender transmits, and both peers abort
  a stream that exceeds its outstanding credit. Application code normally only
  creates or consumes the stream and does not send credit messages itself.

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
const blob = client.createBlob('file contents', {
  type: 'text/plain',
  filename: 'readme.txt',
})
await client.call.upload({ file: blob })

// client.createBlob(...) accepts:
//   Blob (and File), ReadableStream, string, AsyncIterable<Uint8Array>
```

## Blob Download

```ts
const blob = await client.call.download({ content: 'hello' })

// blob is a protocol blob marker carrying metadata
// { type: 'text/plain', size: 12 }
blob.metadata

const controller = new AbortController()
const stream = client.consumeBlob(blob, { signal: controller.signal })

for await (const chunk of stream) {
  // process chunk
}
```

- Download results are lazy: no bytes flow until `client.consumeBlob(blob)` is called.
- `client.consumeBlob(blob)` is the explicit boundary between metadata/reference handling and stream consumption.
- `client.consumeBlob(blob, { signal })` supports aborting blob consumption, similar to the previous callable consumer API.

## Disconnect

```ts
await client.disconnect()
```
