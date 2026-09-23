# @nmtjs/effect

Run a supervised Effect application in a Neem worker. The application supplies its
services, main effect, and upstreams; the preset owns their lifetime. Neem itself
has no Effect dependency.

It targets **Effect 4.0.0-rc.116**, pinned exactly. The preset imports only
stable Effect modules. Applications choose and pin their own HTTP, RPC, and platform
integrations, including any unstable APIs.

During the release-candidate phase, the preset's exact peer pin requires the preset
and application to upgrade together. Each upgrade must rerun the lifecycle and
application-boundary tests; compatibility across other RC versions is not promised.

```ts
// neem.runtime.ts
import { createEffectRuntime } from '@nmtjs/effect'

export default createEffectRuntime({
  name: 'api',
  worker: { entry: './neem.worker.ts' },
})
```

```ts
// neem.worker.ts — HTTP is application code, not part of the preset.
import { createServer } from 'node:http'
import { NodeHttpServer } from '@effect/platform-node'
import { defineEffectWorker } from '@nmtjs/effect/neem/worker'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { HttpServer, HttpServerResponse } from 'effect/unstable/http'

export default defineEffectWorker(() => ({
  layer: Layer.empty,
  main: (ready) =>
    Effect.gen(function* () {
      const server = yield* NodeHttpServer.make(createServer, {
        host: '127.0.0.1',
        port: 0,
      })
      yield* server.serve(Effect.succeed(HttpServerResponse.text('hello')))
      yield* ready([
        { type: 'http', url: HttpServer.formatAddress(server.address) },
      ])
      yield* Effect.never
    }),
}))
```

Under `neem dev`, an edit restarts the worker in its existing thread only when the
new generation reports the same upstreams. With `port: 0` every generation binds a new
port, so each edit falls back to restarting the runtime; use a fixed port in
development to keep in-place restarts.

Register `./neem.runtime.ts` in Neem's `runtimes`. Normal `neem dev`, `neem build`,
and `neem start` commands apply. The default planner starts one worker; a custom
Neem planner can replace it. The worker factory receives Neem's context, including
its logger, mode, and planner data.

## Lifetime

- The layer is built lazily when Neem starts the worker. It must provide every
  service required by `main`; `main` also receives an application scope.
- Call `ready(upstreams)` after resources are listening. `ready()` also supports
  workers without an HTTP upstream. Keep the main effect alive afterward.
- One scoped fiber runs the main effect with its layer. A separate ManagedRuntime
  is unnecessary for this single entry point. Main resources finalize before
  layer services, so cleanup can still use those services.
- The fiber's exit drives `NeemRuntime.finished`, after finalizers complete. Any
  exit before Neem requests stop is a failure, including success and interruption.
  Neem's existing worker recovery handles that failure.
- Calling the preset's `runtime.stop()` interrupts the main fiber and waits for
  finalizers, including during startup. Repeated start/stop calls
  are idempotent; a stopped instance cannot restart. Finalizer defects remain visible.

Neem delivers stop during startup, including while an asynchronous worker factory
is resolving. It calls `runtime.stop()` once after the runtime exists and suppresses
late readiness. The hard five-second worker shutdown deadline still applies to
factory completion and finalizers together; unbounded startup or cleanup can require
thread termination.

Compose essential background work into the main effect, or join and supervise its
fibers explicitly. Forking background work from a layer does not automatically
make that work's failure fail the main fiber.

Use cooperative work and bounded finalizers. An uninterruptible region or a Promise
that ignores its AbortSignal can outlive interruption; the preset cannot kill that
JavaScript work. Neem's worker shutdown deadline and thread termination remain the
outer boundary.

The preset does not currently bridge Effect logging into Neem's Pino logger.
Applications receive `ctx.logger` and own their Effect logger configuration. A runtime
rejection with a single non-interrupt cause keeps that failure's identity; several
causes are rendered with `Cause.pretty` and kept as the error's `cause`. Structured
Cause diagnostics for the host's logs remain a follow-up.

## Application and client boundary

The preset provides no procedures, schemas, transport protocol, or Promise client
facade. Effect RPC or HttpApi belongs to the application, as do uploads and auth.

For a Promise-based frontend, one tested pattern is an application-owned wrapper
over `RpcClient`. Its ManagedRuntime owns the HTTP client protocol; each call owns
an RPC scope and accepts an AbortSignal. The application explicitly
marks the HTTP effect returned by `RpcServer.toHttpEffect` interruptible: in the
pinned version, the HTTP handler otherwise starts uninterruptible, so disconnecting
a request does not promptly close its RPC scope. A server-finalizer test verifies
this behavior. Interruption still does not guarantee a non-cooperative database
query has stopped.
