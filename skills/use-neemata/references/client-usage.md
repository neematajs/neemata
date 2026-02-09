---
title: Client Usage
description: Setting up type-safe clients with StaticClient, making RPC calls,
  consuming streams, and sending/receiving blobs.
---

# Client Usage

## Client Setup

```typescript
import { StaticClient, ProtocolBlob } from 'nmtjs'
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
  },
  WsTransportClient,
  { url: 'ws://localhost:4000' },
)

await client.connect()
```

- `StaticClient` — Proxy-based, type-safe calls using contract types at compile time
- `RuntimeClient` — Pre-built callers with runtime encode/decode via contract schemas
- Transport options: `WsTransportClient` (bidirectional) or `HttpTransportClient` (unidirectional)

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
import { ProtocolBlob } from 'nmtjs'

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
