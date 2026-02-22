---
title: RPC
description: Procedures, routers, streaming, blobs, contracts, guards, middleware,
  filters, and error handling patterns.
---

# RPC

## Basic Procedure

```typescript
import { n, t } from 'nmtjs'

export const pingProcedure = n.procedure({
  input: t.object({}),
  output: t.object({ message: t.string() }),
  handler: () => ({ message: 'pong' }),
})
```

- `handler` receives `(dependencies, input)` — if no `dependencies` option, first arg is `{}`
- Return value must match `output` type

## Procedure with Dependencies

```typescript
import { n, t, Scope } from 'nmtjs'

const dbInjectable = n.factory({
  scope: Scope.Global,
  factory: () => createDbConnection(),
  dispose: (db) => db.close(),
})

export const getUserProcedure = n.procedure({
  dependencies: { db: dbInjectable },
  input: t.object({ id: t.string() }),
  output: t.object({ name: t.string(), email: t.string() }),
  handler: async ({ db }, { id }) => {
    return await db.findUser(id)
  },
})
```

## Router Setup

```typescript
import { n } from 'nmtjs'

// Group procedures into named routers
const usersRouter = n.router({
  routes: {
    getUser: getUserProcedure,
    listUsers: listUsersProcedure,
  },
})

// Optional: nested routers
const adminRouter = n.router({
  guards: [adminGuard],
  routes: {
    deleteUser: deleteUserProcedure,
  },
})

// Root router merges all routers
export const router = n.rootRouter([usersRouter, adminRouter])
```

## Contract-First Approach

Define contracts separately (shared between client and server), then implement:

```typescript
import { c, t } from 'nmtjs'

// Shared contract (e.g., in a shared package)
export const greetContract = c.procedure({
  input: t.object({ name: t.string() }),
  output: t.object({ greeting: t.string() }),
})

export const appContract = c.router({
  routes: { greet: greetContract },
})
```

```typescript
import { n } from 'nmtjs'
import { greetContract } from './contracts.ts'

// Server implementation
const greetProcedure = n.contractProcedure(greetContract, {
  handler: (_, { name }) => ({ greeting: `Hello, ${name}!` }),
})
```

## Streaming Procedure (Server → Client)

```typescript
import { n, t } from 'nmtjs'

export const streamProcedure = n.procedure({
  input: t.object({ count: t.number() }),
  output: t.object({ index: t.number() }),
  stream: true,
  async *handler(_, { count }) {
    for (let i = 0; i < count; i++) {
      yield { index: i }
    }
  },
})
```

- Set `stream: true` to enable streaming
- Handler must be an `async *generator` that `yield`s values matching `output` type
- Client consumes via `client.stream.procedureName(input)` which returns `AsyncIterable`

## Streaming with Abort Signal

```typescript
import { n, t } from 'nmtjs'

export const liveDataProcedure = n.procedure({
  dependencies: { signal: n.inject.rpcAbortSignal },
  input: t.object({}),
  output: t.object({ value: t.number() }),
  stream: true,
  async *handler({ signal }) {
    try {
      while (!signal.aborted) {
        yield { value: Math.random() }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    } finally {
      // cleanup runs even on client abort
    }
  },
})
```

- Prefer `n.inject.rpcAbortSignal` in handlers for general cancellation support
  (client abort, client timeout/request abort, and disconnect)
- `n.inject.rpcStreamAbortSignal` is optional and only available when
  `streamTimeout` is configured for that procedure

```typescript
import { n, t } from 'nmtjs'

export const streamWithTimeoutProcedure = n.procedure({
  dependencies: {
    signal: n.inject.rpcAbortSignal,
    streamSignal: n.inject.rpcStreamAbortSignal,
  },
  input: t.object({}),
  output: t.object({ value: t.number() }),
  stream: true,
  streamTimeout: 5_000,
  async *handler({ signal, streamSignal }) {
    while (!signal.aborted && !streamSignal.aborted) {
      yield { value: Math.random() }
    }
  },
})
```

## Blob Upload (Client → Server)

```typescript
import { n, t, c } from 'nmtjs'

export const uploadProcedure = n.procedure({
  input: t.object({ file: c.blob() }),
  output: t.object({ size: t.number() }),
  handler: async (_, input) => {
    const blob = input.file() // returns async iterable of Uint8Array chunks
    const chunks: Uint8Array[] = []
    for await (const chunk of blob) {
      chunks.push(chunk)
    }
    return { size: Buffer.concat(chunks).byteLength }
  },
})

// Client usage:
// import { ProtocolBlob } from 'nmtjs'
// const blob = ProtocolBlob.from('file contents')
// await client.call.upload({ file: blob })
```

## Blob Download (Server → Client)

```typescript
import { n, t, c } from 'nmtjs'

export const downloadProcedure = n.procedure({
  dependencies: { createBlob: n.inject.createBlob },
  input: t.object({ content: t.string() }),
  output: c.blob(),
  handler: ({ createBlob }, { content }) => {
    const buffer = Buffer.from(content, 'utf-8')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer))
        controller.close()
      },
    })
    return createBlob(stream, { type: 'text/plain', size: buffer.byteLength })
  },
})
```

## Guards (Access Control)

```typescript
import { n } from 'nmtjs'

// Guard with DI
const authGuard = n.guard({
  dependencies: { connectionData: n.inject.connectionData },
  can: (ctx) => ctx.connectionData?.authenticated === true,
})

// Simple guard (no dependencies)
const simpleGuard = n.guard((ctx, call) => true)

// Attach to procedure
const protectedProcedure = n.procedure({
  guards: [authGuard],
  input: t.object({}),
  output: t.object({}),
  handler: () => ({}),
})

// Or attach to entire router
const protectedRouter = n.router({
  guards: [authGuard],
  routes: { ... },
})
```

## Middleware (Request Pipeline)

```typescript
import { n } from 'nmtjs'

const loggingMiddleware = n.middleware({
  dependencies: { logger: n.inject.logger('rpc') },
  handle: async (ctx, call, next, payload) => {
    ctx.logger.info({ procedure: call.procedure }, 'Call started')
    const result = await next(payload)
    ctx.logger.info({ procedure: call.procedure }, 'Call completed')
    return result
  },
})

// Simple middleware (no dependencies)
const timingMiddleware = n.middleware(async (ctx, call, next, payload) => {
  const start = Date.now()
  const result = await next(payload)
  console.log(`${call.procedure} took ${Date.now() - start}ms`)
  return result
})
```

## Error Handling

```typescript
import { n, t, ErrorCode, ApiError } from 'nmtjs'

export const procedure = n.procedure({
  input: t.object({ id: t.string() }),
  output: t.object({ name: t.string() }),
  handler: async (_, { id }) => {
    const user = await findUser(id)
    if (!user) {
      throw new ApiError(ErrorCode.NotFound, 'User not found', { id })
    }
    return user
  },
})

// Error filter (catch and transform errors)
const errorFilter = n.filter({
  errorClass: SomeSpecificError,
  catch: (ctx, error) => {
    return new ApiError(ErrorCode.InternalServerError, error.message)
  },
})
```
