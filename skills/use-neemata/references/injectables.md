# Injectables

Injectables are typed dependency tokens. Handlers receive only dependencies
declared by their definition. Logger, connection data, abort signals, pubsub,
and blob helpers are available only when requested.

An injectable is identified by its token object, not by a string name. The same
object also carries the resolved TypeScript type. `value(...)` and `factory(...)`
add a default resolution for that token; `lazy(...)` only declares the token and
type, so a container must provide its value.

End-user code should import `value`, `lazy`, `factory`, `Scope`, and `inject`
from `nmtjs` when those exports are available.

## Handler Dependencies

```ts
import { inject, procedure, t, value } from 'nmtjs'

const config = value({ greeting: 'hello' })

export const greet = procedure({
  dependencies: {
    config,
    logger: inject.logger,
  },
  input: t.object({ name: t.string() }),
  output: t.object({ message: t.string() }),
  handler: ({ config, logger }, input) => {
    logger.info({ name: input.name }, 'greet')
    return { message: `${config.greeting} ${input.name}` }
  },
})
```

Dependency object keys choose handler context names. Token names do not need to
match context names.

## Token Kinds

`value(value)` creates a global token with a default resolved value:

```ts
import { value } from 'nmtjs'

export const settings = value({
  region: 'eu',
  retries: 3,
})
```

`settings` is now both the token used in `dependencies` and the typed contract
for its resolved value. If no container provision overrides it, resolving
`settings` returns the object passed to `value(...)`.

`lazy(scope, label?)` creates a typed token with no default resolution. Runtime,
transport, plugin, or test setup must provide the value before resolution:

```ts
import { lazy, Scope } from 'nmtjs'

export const tenantId = lazy<string>(Scope.Connection, 'Tenant id')
export const requestId = lazy<string>(Scope.Call, 'Request id')
```

`factory({ create, ... })` creates a token with a default resolver function:

```ts
import { factory, inject, Scope } from 'nmtjs'

export const users = factory({
  scope: Scope.Global,
  dependencies: { logger: inject.logger },
  create: ({ logger }) => createUsersService({ logger }),
  dispose: (service) => service.close(),
})
```

`users` is both the token and the service contract for handlers. If no container
provision overrides it, resolution runs `create` in the owning scope and caches
the selected result for that scope.

Factories may also use function shorthand for no-dependency globals:

```ts
import { factory } from 'nmtjs'

export const clock = factory(() => ({ now: () => new Date() }))
```

Use `pick` when create returns a private object but handlers should receive only
part of it. `dispose` receives the private object and dependency context:

```ts
import { factory } from 'nmtjs'

export const db = factory({
  create: async () => {
    const client = await connectDatabase()
    return { client, queries: createQueries(client) }
  },
  pick: ({ queries }) => queries,
  dispose: ({ client }) => client.close(),
})
```

## Scopes

- `Scope.Global` - one instance for application lifetime.
- `Scope.Connection` - one instance for connection lifetime.
- `Scope.Call` - one instance for one RPC call.
- `Scope.Transient` - new instance for every resolution.

Default factory scope is `Global`, unless dependencies require a stricter
scope. A factory depending on a `Call` token becomes `Call` scoped if no explicit
scope is set.

Explicit scopes cannot be looser than dependency scopes:

```ts
import { factory, inject, Scope } from 'nmtjs'

export const invalid = factory({
  scope: Scope.Global,
  dependencies: { signal: inject.rpcAbortSignal },
  create: ({ signal }) => ({ signal }),
})
```

That is invalid because `inject.rpcAbortSignal` is `Call` scoped.

## Optional Dependencies

Use `optional(...)` when a lazy token may not be provided:

```ts
import { factory, inject, optional } from 'nmtjs'

export const cancellation = factory({
  dependencies: {
    signal: optional(inject.rpcStreamAbortSignal),
  },
  create: ({ signal }) => ({ signal }),
})
```

Missing optional dependencies resolve as `undefined`. Missing required lazy
dependencies fail resolution. `optional(...)` only accepts lazy tokens. Value
and factory injectables already provide default resolution behavior.

## Resolution Overrides

Container provisions override a token's default resolution. This is why
`value(...)` and `factory(...)` are defaults, not immutable bindings.

```ts
import { procedure, t, value } from 'nmtjs'

export const settings = value({
  greeting: 'hello',
})

export const greet = procedure({
  dependencies: { settings },
  input: t.object({ name: t.string() }),
  output: t.object({ message: t.string() }),
  handler: ({ settings }, input) => ({
    message: `${settings.greeting} ${input.name}`,
  }),
})
```

Package-level setup, transport code, plugins, or tests can provide another value
for the same token:

```ts
container.provide(settings, { greeting: 'hi' })
```

Resolution order:

- Current container provision for the exact token object.
- Token default value from `value(...)`, when resolving a value token.
- Parent container resolution when parent owns the token or can satisfy its
  scope.
- Token default resolver from `factory(...)` in the container that owns the
  matching scope.
- Missing `lazy(...)` required token fails; missing optional token returns
  `undefined`.

Child containers can override parent provisions by providing the same token in
the child scope. `container.withhold(token)` removes a provision and exposes the
next available resolution source again.

Provided values must match the token's resolved type. Low-level integration code
may provide another injectable for a token; the container resolves that
injectable lazily and uses its lifecycle.

## Provisioning

Application handlers declare dependencies; hosts, transports, plugins, and tests
provide lazy values into the active container.

```ts
import { lazy, Scope } from 'nmtjs'

export const auth = lazy<{ userId: string }>(Scope.Connection, 'Auth')
```

Package-level code provides values at matching scope:

```ts
container.provide(auth, { userId: 'u_123' })
```

Provisioned values can also be injectables. In that case resolution stays lazy
and the provided injectable owns its lifecycle.

## Lifecycle

- Factory `create` runs once per scope instance, except `Transient`.
- Concurrent resolutions share one in-flight factory call for cached scopes.
- `dispose` runs when the owning scope container is disposed.
- Disposal order is dependants before dependencies.
- Container-wide disposal logs disposal errors; explicit disposal propagates
  errors to the caller.

`inject.dispose` can dispose a dependency manually. Prefer normal scope disposal
unless the resource lifetime is shorter than the scope. For transient tokens,
package-level code that resolved the token directly must pass the specific
instance to dispose.

## Inline Injection

`inject.inject` resolves an injectable with temporary dependency overrides. This
is low-level glue for framework/package code, not the normal handler path.

```ts
import { factory, inject, value } from 'nmtjs'

const greeting = value('hello')
const message = factory({
  dependencies: { greeting },
  create: ({ greeting }) => `${greeting} world`,
})

export const resolveMessage = factory({
  dependencies: { resolve: inject.inject },
  create: ({ resolve }) => resolve(message, { greeting: 'hi' }),
})
```

`inject.inject.explicit(...)` returns `{ instance, [Symbol.asyncDispose] }` for
explicit resource blocks when `using` is supported.

## Built-In Tokens

Prefer merged `inject.*` tokens in application code:

- Core: `inject.logger`, `inject.inject`, `inject.dispose`.
- Gateway: `inject.connection`, `inject.connectionId`,
  `inject.connectionData`, `inject.connectionAbortSignal`,
  `inject.rpcAbortSignal`, `inject.rpcClientAbortSignal`,
  `inject.rpcStreamAbortSignal`, `inject.createBlob`, `inject.consumeBlob`.
- PubSub: `inject.pubsubAdapter`, `inject.publish`, `inject.subscribe`.

`CoreInjectables`, `GatewayInjectables`, and
`PubSubInjectables` remain exported for package-level
integration or when an API explicitly expects the namespace form.

## Rules

- Request `inject.logger` explicitly when a handler needs logging.
- Keep connection and call values out of global factories.
- Use `lazy` for externally provided values, not placeholders that app handlers
  should construct themselves.
- Use `factory` for owned services and lifecycle-managed resources.
- Avoid passing the whole container into handlers; declare exact dependencies.
