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

```typescript
n.procedure({
  input: TType,              // t.* type schema for input validation
  output: TType,             // t.* type schema for output validation
  stream?: boolean,          // true for streaming (handler must be async generator)
  dependencies?: Record<string, Injectable>,
  guards?: Guard[],
  middlewares?: Middleware[],
  handler: (deps, input) => output | AsyncIterable<output>,
})
```

### `n.contractProcedure(contract, options)`

Implement a pre-defined contract.

```typescript
n.contractProcedure(contractProcedure, {
  dependencies?: Record<string, Injectable>,
  guards?: Guard[],
  middlewares?: Middleware[],
  handler: (deps, input) => output,
})
```

### `n.router(options)`

Group procedures into a named router.

```typescript
n.router({
  name?: string,
  routes: Record<string, Procedure | Router>,
  guards?: Guard[],
  middlewares?: Middleware[],
  timeout?: number,          // per-procedure timeout in ms
})
```

### `n.contractRouter(contract, options)`

Implement a contract-defined router.

```typescript
n.contractRouter(routerContract, {
  routes: Record<string, Procedure>,
  guards?: Guard[],
  middlewares?: Middleware[],
})
```

### `n.rootRouter(routers, defaultProcedure?)`

Merge multiple routers into the root router for an application.

```typescript
n.rootRouter(
  [router1, router2, ...] as const,
  defaultProcedure?,  // optional fallback for unknown routes
)
```

### `n.guard(options | canFn)`

Access control guard.

```typescript
// With dependencies
n.guard({
  dependencies?: Record<string, Injectable>,
  can: (deps, call) => boolean | Promise<boolean>,
})

// Shorthand (no deps)
n.guard((ctx, call) => boolean)
```

### `n.middleware(options | handleFn)`

Request pipeline middleware.

```typescript
// With dependencies
n.middleware({
  dependencies?: Record<string, Injectable>,
  handle: (deps, call, next, payload) => Promise<result>,
})

// Shorthand
n.middleware(async (ctx, call, next, payload) => next(payload))
```

### `n.filter(options)`

Error filter — catches specific error types and transforms them.

```typescript
n.filter({
  errorClass: ErrorConstructor,
  dependencies?: Record<string, Injectable>,
  catch: (deps, error) => ApiError,
})
```

### `n.hook(options)`

Named hook handler.

```typescript
n.hook({
  name: string,              // hook name (e.g., GatewayHook.Connect)
  dependencies?: Record<string, Injectable>,
  handler: (deps, ...args) => any,
})
```

### `n.plugin(options)`

Plugin with lifecycle hooks and injections.

```typescript
n.plugin({
  name: string,
  hooks?: Hook[],
  injections?: Injection[],
})
```

### `n.app(options)` — `defineApplication`

Define an application module.

```typescript
n.app({
  router: RootRouter,                           // Required
  transports?: Record<string, TransportClass>,   // e.g., { ws: WsTransport, http: HttpTransport }
  guards?: Guard[],
  middlewares?: Middleware[],
  filters?: Filter[],
  plugins?: Plugin[],
  hooks?: Hook[],
  identity?: ConnectionIdentity,
  api?: { timeout?: number },
})
```

### `n.server(options)` — `defineServer`

Define the server configuration.

```typescript
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

```typescript
n.transport({
  factory: TransportClass,
  injectables?: Record<string, Injectable>,
  proxyable?: { type: ProxyableTransportType },
})
```

### Dependency Injection Builders

```typescript
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

Built-in injectables:

| Injectable | Scope | Type |
|---|---|---|
| `n.inject.logger` | Global | `Logger` |
| `n.inject.logger('label')` | Global | `Logger` (labeled) |
| `n.inject.inject` | Global | DI inject function |
| `n.inject.dispose` | Global | DI dispose function |
| `n.inject.connection` | Connection | `GatewayConnection` |
| `n.inject.connectionId` | Connection | `string` |
| `n.inject.connectionData` | Connection | `unknown` |
| `n.inject.connectionAbortSignal` | Connection | `AbortSignal` |
| `n.inject.rpcClientAbortSignal` | Call | `AbortSignal` |
| `n.inject.rpcStreamAbortSignal` | Call | `AbortSignal` |
| `n.inject.rpcAbortSignal` | Call | `AbortSignal` |
| `n.inject.createBlob` | Call | Blob factory function |

### Metrics

```typescript
n.metrics.counter({ name, help, labelNames? })
n.metrics.gauge({ name, help, labelNames? })
n.metrics.histogram({ name, help, labelNames?, buckets? })
n.metrics.summary({ name, help, labelNames?, percentiles? })
```

### Jobs

```typescript
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

n.jobRouter(...)             // Create job management API router
n.jobRouterOperation(...)    // Single job operation
```

---

## `c.*` Namespace (Contract)

### `c.procedure(options)`

```typescript
c.procedure({
  input?: TType,
  output?: TType,
  stream?: boolean,
  timeout?: number,
})
```

### `c.router(options)`

```typescript
c.router({
  name?: string,
  routes: Record<string, ProcedureContract | RouterContract>,
  timeout?: number,
})
```

### `c.event(options?)`

```typescript
c.event({
  payload?: TType,
})
```

### `c.subscription(options)`

```typescript
c.subscription({
  events: Record<string, EventContract>,
})
```

### `c.blob()`

Marker type for blob fields in input/output schemas.

```typescript
// In input — client sends a ProtocolBlob, server receives a blob accessor function
// In output — server returns a blob via createBlob, client receives async iterable
```

---

## `t.*` Namespace (Type System)

Type schemas for RPC validation and protocol serialization.

Neemata types are **bidirectional**:

- **decode**: wire format → app values (e.g. ISO string → `Date`)
- **encode**: app values → wire format (e.g. `Date` → ISO string)

For full details (including Standard Schema support), see [Type System](type-system.md).

### Primitives

```typescript
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

```typescript
t.object({ key: t.string(), age: t.number() })
t.array(t.string())           // Chainable: .min(n), .max(n), .length(n)
t.tuple([t.string(), t.number()])
t.enum(['a', 'b', 'c'])
t.union(t.string(), t.number())
t.literal('hello')
```

### Special Types

```typescript
t.date()                       // Date ↔ ISO string (auto encode/decode in protocol)
t.custom({ decode, encode })   // Custom bidirectional transform
```

### Modifiers (chainable on any type)

```typescript
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

```typescript
// Decode/encode modes
type DecodeInput = t.infer.decode.input<typeof myType>
type DecodeOutput = t.infer.decode.output<typeof myType>
type EncodeInput = t.infer.encode.input<typeof myType>
type EncodeOutput = t.infer.encode.output<typeof myType>

// Raw modes (pre/post transforms)
type DecodeRawInput = t.infer.decodeRaw.input<typeof myType>
type DecodeRawOutput = t.infer.decodeRaw.output<typeof myType>
type EncodeRawInput = t.infer.encodeRaw.input<typeof myType>
type EncodeRawOutput = t.infer.encodeRaw.output<typeof myType>
```

### Standard Schema (quick)

```typescript
// Standard Schema v1 (defaults to decode mode)
myType['~standard']

// Explicit modes
myType.standard.decode['~standard']
myType.standard.encode['~standard']
```

---

## Enums & Classes

### `Scope`

```typescript
Scope.Global       // Singleton
Scope.Connection   // Per connection
Scope.Call         // Per RPC call
Scope.Transient    // New every injection
```

### `ErrorCode`

```typescript
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

```typescript
new ApiError(code: ErrorCode, message: string, data?: any)
```

### `ProtocolBlob`

```typescript
ProtocolBlob.from(source, metadata?, encode?)
// source: ReadableStream | File | Blob | string | ArrayBuffer | Uint8Array
// metadata: { type?: string, size?: number, filename?: string }
```

### `ConnectionType`

```typescript
ConnectionType.Bidirectional    // WebSocket — full duplex
ConnectionType.Unidirectional   // HTTP — request/response
```

### `GatewayHook`

```typescript
GatewayHook.Connect       // Fired on new connection
GatewayHook.Disconnect    // Fired on disconnect
```

### `LifecycleHook`

```typescript
LifecycleHook.BeforeInitialize
LifecycleHook.AfterInitialize
LifecycleHook.BeforeDispose
LifecycleHook.AfterDispose
```
