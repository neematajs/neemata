# API Reference

`nmtjs` is the end-user import surface for Neemata server/application code.
Prefer named imports from `nmtjs` over direct leaf packages when the symbol is
exported here.

```ts
import {
  app,
  ApiError,
  blobType,
  c,
  ConnectionType,
  contractProcedure,
  contractRouter,
  CoreInjectables,
  envConfig,
  EnvConfigError,
  ErrorCode,
  ExecutionEnvironmentLifecycleHook,
  factory,
  filter,
  GatewayInjectables,
  GatewayHook,
  guard,
  hook,
  host,
  implementRouter,
  inject,
  lazy,
  logging,
  MetadataKind,
  meta,
  metrics,
  middleware,
  optional,
  plugin,
  procedure,
  ProtocolBlob,
  ProxyableTransportType,
  PubSubInjectables,
  pubsubPlugin,
  rootRouter,
  router,
  Scope,
  stream,
  t,
  transport,
  value,
  type ConnectionIdentityType,
} from 'nmtjs'
```

## Import Rules

- Use `nmtjs` for app definitions, procedures, routers, contracts via `c`,
  schemas via `t`, DI, built-in injectables via `inject`, pubsub
  plugins, protocol enums/classes exported above.
- Use direct packages for clients, server handlers, hosts, codecs, adapters,
  and runtime helpers: `@nmtjs/client`, `@nmtjs/transports/neemata/http`,
  `@nmtjs/transports/http-server/node`, `@nmtjs/application/neem/runtime`,
  `@nmtjs/pubsub/redis`, etc.
- Avoid direct `@nmtjs/core`, `@nmtjs/type`, `@nmtjs/contract`,
  `@nmtjs/config`, or `@nmtjs/pubsub` imports in end-user examples when
  `nmtjs` exposes the same symbol.

## Common Builders

- `procedure(options | handler)` - define procedure and infer contract.
- `stream(options)` - define a server-stream route (async-iterable output,
  exposed on `client.stream.*`; optional `streamTimeout`).
- `contractProcedure(contract, options | handler)` - implement procedure
  contract.
- `implementRouter(contract)` - callable contract implementation builder.
- `router({ routes, guards?, middlewares?, meta?, timeout? })` - group routes.
- `contractRouter(contract, { routes, ... })` - implement router contract.
- `rootRouter([routerA, routerB])` - compose root API; duplicate top-level
  route keys throw at composition time.
- `app({ router, guards?, middlewares?, filters?, plugins?, hooks?, meta? })` -
  pure application definition.
- `host(application, { transports })` - bind app to serving surfaces.
- `transport({ factory, injectables?, proxyable? })` - describe transport.

## Contracts And Types

- `t` - schema builders with decode and encode modes.
- `c.procedure(...)`, `c.stream(...)`, `c.router(...)`, `c.event(...)`,
  `c.subscription(...)` - public API contracts.
- `blobType()` - protocol blob marker type for input/output schemas.
- `ProtocolBlob`, `ConnectionType`, `ErrorCode` - protocol helpers.

## DI And Metadata

- `value(value)` - static injectable.
- `lazy(scope, label?)` - late-provided token.
- `optional(lazyToken)` - marks a lazy dependency as optional.
- `factory({ scope?, dependencies?, create, dispose?, pick? })` - scoped
  factory.
- `inject` - merged built-ins: core, gateway, pubsub.
- `CoreInjectables`, `GatewayInjectables`, etc. are still exported, but prefer
  `inject.*` in application examples unless a package API specifically asks for
  the namespace.
- `Scope` - `Global`, `Connection`, `Call`, `Transient`.
- `meta()` and `MetadataKind` - typed metadata tokens and static constraints.

## Config

- `envConfig(variables, { source? }?)` - global injectable resolving and
  validating environment variables on first injection. Each record key is the
  env variable name and maps to a Standard Schema validator (`t.*` schemas
  qualify); the `{ name, schema }` value form decouples config key from env
  variable name.
- `EnvConfigError` - thrown with validation failures aggregated across all
  variables, keyed by env variable name in `error.issues`.
- `resolveEnvConfig(variables, source?)` - non-DI resolver, direct import from
  `@nmtjs/config`.

## PubSub

- `pubsubPlugin(...)`, plus `inject.publish` and `inject.subscribe`.

## Metrics

- `metrics.counter(...)`, `metrics.gauge(...)`, `metrics.histogram(...)`,
  `metrics.summary(...)` create Prometheus-compatible metrics registered in the
  default Neem metrics registry.

## Source Lookup

When docs and types disagree, trust current source:

```bash
rg "export .*symbol|symbol" packages/nmtjs/src packages/*/src
rg "function createProcedure|export function implement" packages/application/src
```
