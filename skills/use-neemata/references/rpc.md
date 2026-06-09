# RPC

RPC docs cover handler execution, route composition, and request/response
features. Public API shape lives in contracts; contract-backed handlers live in
implementations.

## Procedure

```ts
import { procedure, t } from 'nmtjs'

export const ping = procedure({
  input: t.object({}),
  output: t.object({ message: t.string() }),
  handler: () => ({ message: 'pong' }),
})
```

Handlers receive `(ctx, input)`. `ctx` contains only requested dependencies.
If no dependencies are requested, `ctx` is `{}`.

## Procedure With Dependencies

```ts
import { factory, procedure, Scope, t } from 'nmtjs'

const users = factory({
  scope: Scope.Global,
  create: () => createUsersService(),
  dispose: (service) => service.close(),
})

export const getUser = procedure({
  dependencies: { users },
  input: t.object({ id: t.string() }),
  output: t.object({ name: t.string() }),
  handler: ({ users }, input) => users.get(input.id),
})
```

## Routers

```ts
import { rootRouter, router } from 'nmtjs'

const usersRouter = router({
  routes: { getUser },
})

export const api = rootRouter([usersRouter] as const)
```

Rules:

- Route object keys are RPC path segments and client property names.
- `rootRouter([...])` merges top-level routes; duplicate keys overwrite.
- Router `name` is not a root mount prefix. Mounted route keys win.
- Router guards, middleware, meta, and timeout are behavior, not path shape.

## Guards And Middleware

```ts
import { guard, inject, middleware, procedure, t } from 'nmtjs'

const requireConnection = guard({
  dependencies: { connection: inject.connection },
  can: ({ connection }, call) => Boolean(connection && call.payload),
})

const timing = middleware(async (_ctx, _call, next, payload) => {
  return next(payload)
})

export const protectedProcedure = procedure({
  input: t.object({ id: t.string() }),
  output: t.object({ id: t.string() }),
  guards: [requireConnection],
  middlewares: [timing],
  handler: (_ctx, input) => input,
})
```

Rules:

- Middleware runs before input decoding and sees raw `payload`.
- `next()` forwards current raw payload; `next(payload)` replaces it.
- Guards run after decode and before handler. `call.payload` is decoded but
  guard payload typing is not inferred automatically.
- For reusable typed decoded data in guards/handlers, use metadata factory with
  `phase: 'afterDecode'`.

## Streaming

```ts
import { inject, procedure, t } from 'nmtjs'

export const feed = procedure({
  dependencies: { signal: inject.rpcAbortSignal },
  input: t.object({ limit: t.number() }),
  output: t.object({ value: t.number() }),
  stream: true,
  async *handler({ signal }, input) {
    for (let value = 0; value < input.limit && !signal.aborted; value++) {
      yield { value }
    }
  },
})
```

Rules:

- `stream: true` exposes procedure under `client.stream.*`.
- Non-stream procedures expose under `client.call.*`.
- `stream: <milliseconds>` adds explicit stream timeout behavior and exposes
  `inject.rpcStreamAbortSignal`.
- Public contract stores numeric stream config as `stream: true`; timeout is
  implementation behavior.
- Stream chunks are output-encoded/validated unless output serialization is
  disabled by config metadata.

## Blobs

```ts
import { blobType, inject, procedure, t } from 'nmtjs'

export const upload = procedure({
  dependencies: { consumeBlob: inject.consumeBlob },
  input: t.object({ file: blobType() }),
  output: t.object({ size: t.number() }),
  async handler({ consumeBlob }, input) {
    let size = 0
    for await (const chunk of consumeBlob(input.file)) {
      size += chunk.byteLength
    }
    return { size }
  },
})
```

```ts
import { blobType, inject, procedure } from 'nmtjs'

export const download = procedure({
  dependencies: { createBlob: inject.createBlob },
  output: blobType(),
  handler: ({ createBlob }) => {
    return createBlob('hello', { type: 'text/plain' })
  },
})
```

If a handler never consumes an uploaded blob, upload stream cleanup happens when
the handler finishes. Download bytes are lazy until client calls
`consumeBlob(...)`.

## Metadata

```ts
import { meta, MetadataKind, procedure, t } from 'nmtjs'

const area = meta<string, MetadataKind.STATIC>()
const decodedInput = meta<{ id: string }>()

export const item = procedure({
  input: t.object({ id: t.string() }),
  output: t.object({ id: t.string() }),
  meta: [
    area.static('admin'),
    decodedInput.factory({
      phase: 'afterDecode',
      resolve: (_ctx, _call, input) => input,
    }),
  ],
  dependencies: { decoded: decodedInput },
  handler: ({ decoded }) => decoded,
})
```

Rules:

- Static metadata can attach at application, router, procedure, and job-router
  level.
- Static metadata merges outer to inner; narrower bindings override.
- `beforeDecode` receives raw payload. `afterDecode` receives decoded input.
- Metadata tokens are injectables.

## Error Filters

```ts
import { ApiError, ErrorCode, filter } from 'nmtjs'

const notFoundFilter = filter({
  errorClass: NotFoundError,
  catch: (_ctx, error) => new ApiError(ErrorCode.NotFound, error.message),
})
```

Use filters for known error translation. Throw protocol/API errors directly
when the handler already knows public error semantics.
