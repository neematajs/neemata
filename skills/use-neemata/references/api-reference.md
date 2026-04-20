---
title: API Quick Reference
description: Function signatures and available options for the Neemata n.*, t.*, and
  c.* APIs.
---

# API Quick Reference

## `n.*` Namespace (from `nmtjs`)

All builder functions are available via the `n` namespace (or `neemata`).

### `n.procedure(options)`

Create a standalone RPC procedure (auto-generates contract from input/output).

```ts
n.procedure({
  input: TType,              // t.* type schema for input validation
  output: TType,             // t.* type schema for output validation
  stream?: true | number,    // true for streaming, or number for explicit stream timeout in ms
  dependencies?: Record<string, Injectable>,
  guards?: Guard[],
  middlewares?: Middleware[],
  meta?: MetaBinding[],
  handler: (deps, input) => output | AsyncIterable<output>,
})
```

### `n.contractProcedure(contract, options)`

Implement a pre-defined contract.

```ts
n.contractProcedure(contractProcedure, {
  dependencies?: Record<string, Injectable>,
  guards?: Guard[],
  middlewares?: Middleware[],
  meta?: MetaBinding[],
  handler: (deps, input) => output,
})
```

### `n.router(options)`

Group procedures into a named router.

```ts
n.router({
  name?: string,
  routes: Record<string, Procedure | Router>,
  guards?: Guard[],
  middlewares?: Middleware[],
  meta?: MetaBinding[],
  timeout?: number,          // per-procedure timeout in ms
})
```

### `n.contractRouter(contract, options)`

Implement a contract-defined router.

```ts
n.contractRouter(routerContract, {
  routes: Record<string, Procedure>,
  guards?: Guard[],
  middlewares?: Middleware[],
  meta?: MetaBinding[],
})
```

### `n.rootRouter(routers, defaultProcedure?)`

Merge multiple routers into the root router for an application.

```ts
n.rootRouter(
  [router1, router2, ...] as const,
  defaultProcedure?,  // optional fallback for unknown routes
)
```

### `n.guard(options | canFn)`

Access control guard.

```ts
// With dependencies
n.guard({
  dependencies?: Record<string, Injectable>,
  can: (deps, call) => boolean | Promise<boolean>,
})

// Shorthand (no deps)
n.guard((ctx, call) => boolean)
```

- `call.payload` is available inside guards and contains the decoded input payload when the procedure/router defines an `input` schema.
- `n.guard(...)` is untyped for payloads by default, so `call.payload` is `unknown` unless you narrow it manually.
- For reusable, typed decoded-input data, prefer `n.meta(...).factory({ phase: 'afterDecode' })` and inject that metadata into guards/handlers.

### `n.middleware(options | handleFn)`

Request pipeline middleware operating on the raw request payload before input
decoding and guards.

```ts
// With dependencies
n.middleware({
  dependencies?: Record<string, Injectable>,
  handle: (deps, call, next, payload) => Promise<result>,
})

// Shorthand
n.middleware(async (ctx, call, next, payload) => next(payload))
```

- `payload` is the raw request payload, not the decoded guard/handler input.
- `next()` forwards the current raw payload unchanged.
- `next(payload)` forwards or replaces the raw payload for downstream middleware
  and the eventual decode step.
- Use guards when you need decoded `call.payload`.

### `n.meta<Value, Kind>()`

Create a call-scoped metadata token.

```ts
const auditTag = n.meta<string, MetadataKind.STATIC>()
const decodedAccess = n.meta<{ scope: string; createdAt: Date }>()

auditTag.static('admin')

decodedAccess.factory({
  phase: 'afterDecode',
  resolve: (_deps, _call, input) => input,
})
```

- Static bindings can be attached to `n.app({ meta })`, `n.router({ meta })`, `n.procedure({ meta })`, and `n.jobRouter({ meta })`.
- Factory bindings run per call.
- `phase: 'beforeDecode'` receives raw `payload: unknown`.
- `phase: 'afterDecode'` receives the decoded input type at the definition site.
- Meta tokens are injectables, so they can be used in `dependencies`.

### `n.filter(options)`

Error filter — catches specific error types and transforms them.

```ts
n.filter({
  errorClass: ErrorConstructor,
  dependencies?: Record<string, Injectable>,
  catch: (deps, error) => ApiError,
})
```

### `n.hook(options)`

Named hook handler.

```ts
n.hook({
  name: string,              // hook name (e.g., GatewayHook.Connect)
  dependencies?: Record<string, Injectable>,
  handler: (deps, ...args) => any,
})
```

### `n.plugin(options)`

Plugin with lifecycle hooks and injections.

```ts
n.plugin({
  name: string,
  hooks?: Hook[],
  injections?: Injection[],
})
```

### `n.app(options)` — `defineApplication`

Define an application module.

```ts
n.app({
  router: RootRouter,                           // Required
  transports?: Record<string, TransportClass>,   // e.g., { ws: WsTransport, http: HttpTransport }
  guards?: Guard[],
  middlewares?: Middleware[],
  meta?: MetaBinding[],
  filters?: Filter[],
  plugins?: Plugin[],
  hooks?: Hook[],
  identity?: ConnectionIdentity,
  api?: { timeout?: number },
})
```

### `n.server(options)` — `defineServer`

Define the server configuration.

```ts
n.server({
  logger: { pinoOptions: PinoOptions },
  applications: {
    [appName]: {
      threads: Array<{
        ws?: { listen: { port: number, hostname?: string } },
        http?: { listen: { port: number, hostname?: string } },
      }>,
    },
  },
  store?: { type: StoreType, options: RedisOptions },
  proxy?: {
    port: number,
    hostname?: string,
    applications: Record<string, { routing: RoutingConfig }>,
    tls?: TlsConfig,
  },
  jobs?: {
    pools: { Io?: PoolConfig, Compute?: PoolConfig },
    jobs?: Job[],
  },
  metrics?: { port?: number, path?: string },
})
```

### `n.transport(config)`

Create a transport definition.

```ts
n.transport({
  factory: TransportClass,
  injectables?: Record<string, Injectable>,
  proxyable?: { type: ProxyableTransportType },
})
```

### Dependency Injection Builders

```ts
n.value(staticValue)                     // ValueInjectable — wraps a static value
n.lazy<T>(scope?)                        // LazyInjectable — token for late-bound values
n.factory({                              // FactoryInjectable — created via factory function
  dependencies?: Record<string, Injectable>,
  scope?: Scope,                         // Default: Scope.Global
  factory: (deps) => instance,
  dispose?: (instance) => void,
})
```

### `n.inject` (recommended) / `n.injectables` (deprecated)

Built-in injectables include logger, DI helpers, connection context, RPC
cancellation signals, and blob helpers.

For the complete table with scope, types, behavior, and usage guidance, see
[Injectables Reference](injectables.md).

### Metrics

```ts
n.metrics.counter({ name, help, labelNames? })
n.metrics.gauge({ name, help, labelNames? })
n.metrics.histogram({ name, help, labelNames?, buckets? })
n.metrics.summary({ name, help, labelNames?, percentiles? })
```

### Jobs

```ts
n.job({
  name: string,
  steps: Step[],
  retry?: { attempts: number, backoff?: BackoffConfig },
})

n.step({
  input: TType,
  output?: TType,
  dependencies?: Record<string, Injectable>,
  handler: (deps, input) => output,
})

n.jobRouter({
  jobs: Record<string, Job>,
  guards?: Guard[],
  middlewares?: Middleware[],
  meta?: MetaBinding[],
  defaults?: JobRouterDefaults,
  overrides?: JobRouterOverrides,
})

n.jobRouterOperation({
  dependencies?: Record<string, Injectable>,
  guards?: Guard[],
  middlewares?: Middleware[],
  meta?: MetaBinding[],
  timeout?: number,
  // operation-specific hooks: beforeAdd/afterAdd, beforeRetry/afterRetry, etc.
})
```

---

## `c.*` Namespace (Contract)

### `c.procedure(options)`

```ts
c.procedure({
  input?: TType,
  output?: TType,
  stream?: boolean,
  timeout?: number,
})
```

### `c.router(options)`

```ts
c.router({
  name?: string,
  routes: Record<string, ProcedureContract | RouterContract>,
  timeout?: number,
})
```

### `c.event(options?)`

```ts
c.event({
  payload?: TType,
})
```

### `c.subscription(options)`

```ts
c.subscription({
  events: Record<string, EventContract>,
})
```

### `c.blob()`

Marker type for blob fields in input/output schemas.

```ts
// In input — client sends a ProtocolBlob/blob created by client.createBlob(),
//            server receives a blob marker and calls n.inject.consumeBlob to read it
// In output — server returns a blob via n.inject.createBlob,
//             client receives a blob marker and calls client.consumeBlob(blob)
```

---

## `t.*` Namespace (Type System)

Type schemas for RPC validation and protocol serialization.

Neemata types are **bidirectional**:

- **decode**: wire format → app values (e.g. ISO string → `Date`)
- **encode**: app values → wire format (e.g. `Date` → ISO string)

For full details (including Standard Schema support), see [Type System](type-system.md).

### Primitives

```ts
t.string()      // Chainable: .min(n), .max(n), .email(), .url(), .uuid(), .pattern(...)
t.number()      // Chainable: .positive(), .negative(), .gt(n), .gte(n), .lt(n), .lte(n)
t.integer()
t.bigInt()      // bigint → string (wire)
t.boolean()
t.null()
t.any()
t.never()
```

### Composites

```ts
t.object({ key: t.string(), age: t.number() })
t.array(t.string())           // Chainable: .min(n), .max(n), .length(n)
t.tuple([t.string(), t.number()])
t.enum(['a', 'b', 'c'])
t.union(t.string(), t.number())
t.literal('hello')
```

### Special Types

```ts
t.date()                       // Date ↔ ISO string (auto encode/decode in protocol)
t.custom({ decode, encode })   // Custom bidirectional transform
```

### Modifiers (chainable on any type)

```ts
.optional()         // T | undefined
.nullable()         // T | null
.nullish()          // T | null | undefined
.default(value)     // Default value
.title('Name')
.description('...')
.examples(a, b, c)
.meta({...})
```

### Type Inference

```ts
// Decode/encode modes
type DecodeInput = t.infer.decode.input<typeof myType>
type DecodeOutput = t.infer.decode.output<typeof myType>
type EncodeInput = t.infer.encode.input<typeof myType>
type EncodeOutput = t.infer.encode.output<typeof myType>
```

### Standard Schema (quick)

```ts
// Standard Schema v1 (defaults to decode mode)
myType['~standard']

// Explicit modes
myType.standard.decode['~standard']
myType.standard.encode['~standard']
```

---

## Enums & Classes

### `Scope`

```ts
Scope.Global       // Singleton
Scope.Connection   // Per connection
Scope.Call         // Per RPC call
Scope.Transient    // New every injection
```

### `MetadataKind`

```ts
MetadataKind.STATIC     // Token supports `.static(...)` only
MetadataKind.FACTORY    // Internal enum value used by metadata bindings
```

### `ErrorCode`

```ts
ErrorCode.ValidationError
ErrorCode.BadRequest
ErrorCode.NotFound
ErrorCode.Forbidden
ErrorCode.Unauthorized
ErrorCode.InternalServerError
ErrorCode.NotAcceptable
ErrorCode.RequestTimeout
ErrorCode.GatewayTimeout
ErrorCode.ServiceUnavailable
ErrorCode.ClientRequestError
ErrorCode.ConnectionError
```

### `ApiError`

```ts
new ApiError(code: ErrorCode, message: string, data?: any)
```

### `ProtocolBlob`

```ts
ProtocolBlob.from(source, metadata?, encode?)
// source: ReadableStream | File | Blob | string | ArrayBuffer | Uint8Array
// metadata: { type?: string, size?: number, filename?: string }
```

### `ConnectionType`

```ts
ConnectionType.Bidirectional    // WebSocket — full duplex
ConnectionType.Unidirectional   // HTTP — request/response
```

### `GatewayHook`

```ts
GatewayHook.Connect       // Fired on new connection
GatewayHook.Disconnect    // Fired on disconnect
```

### `LifecycleHook`

```ts
LifecycleHook.BeforeInitialize
LifecycleHook.AfterInitialize
LifecycleHook.BeforeDispose
LifecycleHook.AfterDispose
```
