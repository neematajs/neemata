---
title: RPC
description: Procedures, routers, metadata, streaming, blobs, contracts, guards,
  middleware, filters, and error handling patterns.
---

# RPC

## Basic Procedure

```ts
import { n, t } from 'nmtjs'

export const pingProcedure = n.procedure({
  input: t.object({}),
  output: t.object({ message: t.string() }),
  handler: () => ({ message: 'pong' }),
})
```

- `handler` receives `(dependencies, input)` — if no `dependencies` option, first arg is `{}`
- Return value must match `output` type

## Runtime Output Serialization

By default, Neemata serializes and validates procedure outputs through the
`output` schema before sending them to the client. This applies to both regular
responses and each chunk yielded by stream procedures.

When you want the schema only for static typing and you already return
transport-ready values, attach the first-party runtime config metadata:

```ts
import { n, t } from 'nmtjs'

export const fastProcedure = n.procedure({
  output: t.object({ status: t.string() }),
  meta: [n.config.static({ serializeOutput: false })],
  handler: () => ({ status: 'ok' }),
})
```

- `serializeOutput` defaults to `true`.
- Set `serializeOutput: false` at application, router, or procedure scope.
- Narrower scopes override wider scopes.
- Input decoding, guards, middleware, and metadata phases are unchanged.
- Disabling output serialization also skips runtime output validation and output
  transforms, so use it only when the handler returns values compatible with the
  selected transport/client.

## Procedure with Dependencies

```ts
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

```ts
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
export const router = n.rootRouter([usersRouter, adminRouter] as const)
```

## Contract-First Approach

Define contracts separately (shared between client and server), then implement:

```ts
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

```ts
import { n } from 'nmtjs'
import { greetContract } from './contracts.ts'

// Server implementation
const greetProcedure = n.contractProcedure(greetContract, {
  handler: (_, { name }) => ({ greeting: `Hello, ${name}!` }),
})
```

## Streaming Procedure (Server → Client)

```ts
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
- `stream: true` is the standard streaming form and does not add a custom per-procedure stream timeout
- Use `stream: <ms>` (for example `stream: 5_000`) when you want the stream procedure to expose `n.inject.rpcStreamAbortSignal`
- Handler must be an `async *generator` that `yield`s values matching `output` type
- Client consumes via `client.stream.procedureName(input)` which returns `AsyncIterable`

## Streaming with Abort Signal

```ts
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
- `n.inject.rpcClientAbortSignal` is the base per-call signal provided by the
  gateway; `n.inject.rpcAbortSignal` resolves the unified signal by combining
  that call signal with disconnect and optional stream-timeout cancellation.
- Regular `stream: true` procedures are fully valid and usually all you need
  when you do not want a custom per-procedure stream timeout.
- `n.inject.rpcStreamAbortSignal` is optional and only available when
  a timed stream configuration is used for that procedure (for example
  `stream: 5_000`)

```ts
import { n, t } from 'nmtjs'

export const streamWithTimeoutProcedure = n.procedure({
  dependencies: {
    signal: n.inject.rpcAbortSignal,
    streamSignal: n.inject.rpcStreamAbortSignal,
  },
  input: t.object({}),
  output: t.object({ value: t.number() }),
  stream: 5_000,
  async *handler({ signal, streamSignal }) {
    while (!signal.aborted && !streamSignal.aborted) {
      yield { value: Math.random() }
    }
  },
})
```

## Blob Upload (Client → Server)

```ts
import { n, t, c } from 'nmtjs'

export const uploadProcedure = n.procedure({
  dependencies: { consumeBlob: n.inject.consumeBlob },
  input: t.object({ file: c.blob() }),
  output: t.object({ size: t.number() }),
  handler: async ({ consumeBlob }, input) => {
    const blob = consumeBlob(input.file)
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

If a handler never calls `consumeBlob(input.file)`, the upload stream is aborted automatically when the handler finishes.

## Blob Download (Server → Client)

```ts
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

## Metadata Bindings

```ts
import { MetadataKind, n, t } from 'nmtjs'

const allowedMethods = n.meta<Array<'get' | 'post'>, MetadataKind.STATIC>()
const decodedAccess = n.meta<{ scope: string; createdAt: Date }>()

export const protectedProcedure = n.procedure({
  input: t.object({ scope: t.string(), createdAt: t.date() }),
  output: t.object({ scope: t.string() }),
  meta: [
    allowedMethods.static(['post']),
    decodedAccess.factory({
      phase: 'afterDecode',
      resolve: (_ctx, _call, input) => input,
    }),
  ],
  dependencies: { access: decodedAccess },
  handler: ({ access }) => ({ scope: access.scope }),
})
```

- Static metadata can be attached at the application, router, procedure, or jobs-router level.
- Static metadata is merged from outer scope to inner scope; narrower scopes override wider ones.
- `beforeDecode` factory metadata sees the raw payload (`unknown`).
- `afterDecode` factory metadata sees the decoded input type at the definition site.
- Metadata tokens are injectables, so they can be reused in middleware, guards, and handlers.

## Guards (Access Control)

```ts
import { n, t } from 'nmtjs'

// Guard with DI
const authGuard = n.guard({
  dependencies: { connectionData: n.inject.connectionData },
  can: (ctx, call) => {
    return (
      ctx.connectionData?.authenticated === true &&
      call.payload !== undefined
    )
  },
})

// Simple guard (no dependencies)
const simpleGuard = n.guard((_ctx, call) => call.payload !== undefined)

// Guard that depends on typed metadata resolved after decode
const scopedGuard = n.guard({
  dependencies: { access: decodedAccess },
  can: ({ access }) => {
    return access.scope === 'user' && access.createdAt instanceof Date
  },
})

// Attach to procedure
const protectedProcedure = n.procedure({
  guards: [authGuard, scopedGuard],
  input: t.object({
    scope: t.string(),
    createdAt: t.date(),
  }),
  output: t.object({}),
  handler: () => ({}),
})

// Or attach to entire router
const protectedRouter = n.router({
  guards: [authGuard],
  routes: { ... },
})
```

- Guards run before the handler.
- `call.payload` contains the decoded input payload, so transforms like `t.date()` are already applied.
- `n.guard(...)` does not infer the payload type automatically; narrow `call.payload` manually if you read it directly.
- Prefer `n.meta(...).factory({ phase: 'afterDecode' })` when you want reusable typed values in guards and handlers.

## Middleware (Request Pipeline)

Middleware runs on the **raw request payload** before input decoding and before
guards execute. Use middleware for request context, correlation IDs, raw payload
logging, or pre-validation payload rewriting.

```ts
import { n } from 'nmtjs'

const loggingMiddleware = n.middleware({
  dependencies: { logger: n.inject.logger('rpc') },
  handle: async (ctx, call, next, payload) => {
    ctx.logger.info(
      { procedure: call.procedure.contract.name, payload },
      'Raw call started',
    )
    const result = await next()
    ctx.logger.info(
      { procedure: call.procedure.contract.name },
      'Call completed',
    )
    return result
  },
})

// Simple middleware (no dependencies)
const timingMiddleware = n.middleware(async (ctx, call, next, payload) => {
  const start = Date.now()
  const result = await next()
  console.log(`${call.procedure.contract.name} took ${Date.now() - start}ms`)
  return result
})
```

- `payload` is the raw inbound payload as received by the RPC pipeline.
- `next()` forwards the current raw payload unchanged.
- `next(newPayload)` replaces the raw payload for downstream middleware and the
  eventual decode step.
- If you need decoded input with transforms applied (for example `t.date()` →
  `Date`), use a guard or the procedure handler instead.
- For stream procedures, middleware wraps stream creation and sees the returned
  stream object rather than each emitted chunk.

## Error Handling

```ts
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
