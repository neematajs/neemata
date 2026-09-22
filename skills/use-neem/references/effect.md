# Effect Applications

`@nmtjs/effect` hosts one supervised Effect application per Neem worker.
Its required peer is exactly `effect@4.0.0-rc.116`; applications and preset
must upgrade together. Neem itself does not depend on Effect. The app owns its
HTTP/RPC/platform integrations, schemas and clients; the preset supplies none.

## Declaration and Planner

```ts
// neem.runtime.ts
import { createEffectRuntime } from '@nmtjs/effect'

export default createEffectRuntime({
  name: 'api',
  worker: { entry: './neem.worker.ts' },
})
```

Register the declaration in config `runtimes`. Unlike
`createWorkflowsRuntime()`, `createEffectRuntime` directly takes the declaration.
It defaults `planner` to `@nmtjs/effect/neem/planner`, whose default export
returns `{ workers: [{}] }`: one worker with empty planner data. Supply a
custom Neem planner entry to replace it. The preset adds no custom host or
transport; normal Neem build/dev/start and proxy declarations apply.

## Application Contract

```ts
// neem.worker.ts
import { defineEffectWorker } from '@nmtjs/effect/neem/worker'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

export default defineEffectWorker(() => ({
  layer: Layer.empty,
  main: (ready) =>
    Effect.gen(function* () {
      yield* ready()
      // Readiness must not end the supervised application lifetime.
      yield* Effect.never
    }),
}))
```

`defineEffectWorker(create)` expects a synchronous factory returning
`EffectApplication<R, EL, EM>`: `{ layer, main }`. Put asynchronous resource
acquisition in the Layer/main Effect, not an async factory. The factory receives
`NeemRuntimeWorkerContext<Data, undefined>` (`mode`, worker `name`, planner
`data`, Pino `logger`, `port`, and `definition: undefined`).

- `layer` is required, even when empty: `Layer.Layer<R, EL>` with no remaining
  inputs. It must provide all services needed by main. Layer errors and main
  errors are independently inferred.
- `main(ready)` returns `Effect.Effect<unknown, EM, R | Scope.Scope>`; the
  preset supplies a scope and lazily builds the Layer when the worker starts.
- `Ready` is exported from `@nmtjs/effect/neem/worker`. Calling it returns
  `Effect.Effect<void>`: execute it with `yield* ready(...)`, not just `ready()`.
- For a server, acquire listeners first, then signal
  `ready([{ type: 'http', url: listeningUrl }])` (also `'http2'` or `'ws'`).
  Use real bound URLs, especially with port 0. `ready()` reports no upstreams.
  Startup waits for this signal; it does not infer readiness from Layer success.
- Keep main alive after readiness. Compose essential background work into main,
  or explicitly join/supervise its fibers. Forking work in a Layer does not
  automatically make its failure fail main.

## Lifetime and Diagnostics

One supervised fiber owns the application. Main's scope closes before Layer
services, so application finalizers can still use them. `finished` settles
after finalizers. Any exit before requested stop is failure, including success
and interruption, and is reported to Neem.

`stop()` interrupts and joins the fiber, including before readiness. Repeated
start/stop calls are idempotent; a stopped instance cannot restart. Pure
interruption during requested stop is normal; finalizer failures remain
observable. Neem delivers stop during startup and suppresses late readiness,
but its hard 5,000 ms thread deadline includes factory completion and all
finalizers. Keep acquisition and cleanup bounded; interruption cannot cancel
non-cooperative Promise work or guarantee completion of uninterruptible cleanup.

A single non-interruption cause is squashed to its underlying failure; several
are rendered with `Cause.pretty` and retained as an error cause inside the
worker. The host receives a serialized summary (`NeemWorkerError`), not a
structured Effect Cause. Effect logging is not automatically bridged to Pino:
use `ctx.logger` or configure Effect logging in the application.
