# Neem

An application host built on Effect 4: build and watch applications, supervise
worker threads, route traffic, and shut resources down within a shared deadline.
The CLI and package name remain `neem` and `@nmtjs/neem`.

## Run

```sh
neem dev --config neem.config.ts
neem build --config neem.config.ts
neem start --out-dir dist
# Or run the built application directly:
node dist/start.js
```

Existing configuration, planner, worker, Nuxt, and Vite imports stay the same.
Application presets may return values or Promises; applications do not need to
use Effect. `@nmtjs/effect` remains the preset for applications that use Effect
services and scoped resources themselves.

## Migration

The Effect host replaces the previous implementation; `@nmtjs/neem-effect` is
removed. Change imports from that package to `@nmtjs/neem`, including `/host`,
and replace the `neem-effect` executable with `neem`. The Promise facade is now
named `HostController`. Remove old build output and run `neem build` again:
manifest schema version 4 is deliberately rejected, since its bundled worker
transport is incompatible with this host. Fresh builds use version 5.

Pino, the native proxy, runtime declarations, and Promise-based presets remain.
Hooks may additionally return Effects, and plugin factories may acquire scoped
Effect resources. Embedded hooks use `createHostHooks()` from `@nmtjs/neem/host`.

## CLI

The command tree uses Effect's `effect/cli`, with Node platform services and
signal handling. Effect currently marks that CLI API unstable.

```sh
neem --help
neem dev --help
neem --version
neem --completions bash # also zsh, fish, sh
neem dev api,jobs --no-cache --env-files .env,.env.local
```

`--outDir` and `--cacheDir` remain aliases for `--out-dir` and `--cache-dir`.
Flags are validated before running a command. On SIGINT/SIGTERM the CLI waits
for cleanup; failed cleanup exits unsuccessfully. Diagnostics go to stderr.

## Ownership and transport

The host serializes mutations with `Semaphore`; shutdown interrupts the active
operation and closes its resources. Each runtime owns a generation scope, which
owns its planner/host runner and parallel worker scopes. A generation's failure
`Deferred` cannot restart a newer generation. Application replacement is serialized
inside each worker, and a cancelled queued patch cannot release another patch's permit.

Effect `RpcClient` / `RpcServer`, schemas, `Transferable`, and
`NodeWorkerRunner` provide requests, replies, cancellation, and MessagePort
transfer. Host-side `Worker.makePlatform` owns readiness buffering and the
receive loop's response-handler fibers. A single-worker `RpcClient.Protocol`
bridge connects it to RPC; a Node adapter supplies events and deadline-aware
native cleanup. It intentionally has no transparent respawn: Neem's runtime
supervisor owns restart policy, backoff, and exhaustion. Fatal exit reports use
a separate synchronous frame so they survive an immediate process exit.

The receive scope is registered before native acquisition. Finalizers therefore
send the stop request, close the RPC client, wait for native exit (or terminate
at the deadline), and finally close the receive scope. That order lets a stop
buffered before readiness reach the worker. Interrupting the receive loop first
would discard that opportunity and force termination. The native worker belongs
to the outer lifetime even though `makePlatform` manages its receive loop.

Every shutdown step spends one absolute deadline. Worker scopes stop together;
a stuck finalizer cannot prevent sibling cleanup. Workers still alive at the
deadline are terminated and shutdown reports failure. Promise-based application
factories remain supported, including ones that finish after shutdown begins.

The compiler, watcher, DevEngine freshness rules, native proxy, and application
contracts remain in Neem. There is one host implementation. Workflows and
distributed cluster scheduling are outside this package's scope.

## First-party services and custom policy

Effect owns background fibers (`FiberSet` / `FiberHandle`), scopes, serialization,
monotonic deadlines, and retry schedules. Callback fibers capture the caller's
Effect services, including its clock and tracing context. Cancelling a queued
host operation removes it before it can mutate the running server.

Lifecycle hooks execute sequentially as Effects. Hooks may return an Effect, a
Promise, or nothing; an interrupted hook cannot continue invoking later callbacks.
Plugin acquisitions register disposal immediately, including partial startup.
`definePluginHooks` from this package also accepts Effect factories using
`acquireRelease`; their resources belong to a plugin scope closed within the
host's shutdown budget.
Plugins dispose in reverse acquisition order. Embedded hosts use the native
`HostHooks` registry; Hookable registries are no longer accepted.
`createHostHooks` and `PluginHooks` are exported from `@nmtjs/neem/host`.

The proxy controller uses Effect serialization and scheduled retries. The native
proxy still forwards traffic. Neem retains route selection, readiness policy,
restart decisions, generation identity, and the single shared shutdown budget.
A native call or Promise that cannot be cancelled may finish after the caller's
budget; its cleanup remains owned and workers can still be forcibly terminated.

Effect Schema validates manifests, runtime upstreams, and RPC envelopes. Normal
RPC failures use Effect's error codec; opaque application values retain structured
clone support (including Maps, BigInts, and typed arrays). Diagnostics therefore
use Effect's schema errors instead of Zod's. The compiler writes manifest
schema version 5. Builds from the previous host must be rebuilt before
starting them with this version.

Effect Config resolves runtime environment overrides and host settings. Invalid
`NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS` values now fail startup instead of accepting
partial numbers. `NEEM_EFFECT_TRACING=true` enables RPC tracing; host operations
and recovery attempts also expose Effect spans to an installed tracer. No tracing
exporter is installed automatically. **Pino remains the logger.**

Plain dotenv files use Effect FileSystem and ConfigProvider, preserving file order
and existing environment values. Files using variable expansion or dotenvx
encryption retain the dotenvx adapter. The compiler, artifact watcher, and
DevEngine retain their existing build and module-update engines.

`Deadline.make(ms)` captures the active Effect clock. `Deadline.after(ms)` is the
synchronous live-clock convenience. `Deadline.at` is monotonic time, not a Unix
timestamp; pass relative budgets through the factories.

## Embed in an Effect application

```ts
import * as Effect from 'effect/Effect'
import { loadSnapshot, serve } from '@nmtjs/neem/host'

const program = Effect.scoped(
  Effect.gen(function* () {
    const snapshot = yield* loadSnapshot({
      mode: 'production',
      outDir: './dist',
      manifestFile: './dist/neem.manifest.json',
    })
    const host = yield* serve(snapshot)
    console.log(host.getHealth())
    yield* Effect.never
  }),
)
```

Run `program` with your application's Effect runtime and signal handling.
Closing its scope stops the host; acquisition failure or interruption also
cleans up resources already acquired. The `Host` methods return Effects.
`HostController` is the Promise facade used by the development CLI.

Conventional runtime and planner lookup recognizes `.ts`, `.mts`, `.js` and
`.mjs` files.

## Runtime restart

`neem dev` builds runtime workers with Rolldown DevEngine. An edit to a worker
or its bundled dependencies stops the current runtime generation and creates
and starts the updated worker in the same thread. Neem awaits cleanup before
starting the replacement; planners and hosts keep their existing rebuild and
reload behavior. Every restart of a patched runtime, including host recovery
after a crash, first rewrites the worker output so it loads the accepted
patches.

A changed upstream list, a rejected or failed patch, a thread that was not
registered for the update, an update to a module that has not run yet (such as
one reached only through a pending dynamic `import()`), or a worker declaring
`reload: 'thread'` falls back to restarting the runtime: all of its worker
threads and its host runner start again from fresh output. Fallback logs
include the reason. Syntax errors are logged and leave the last good generation
running until the source is fixed. A restart never loads output older than the
running generation; when the latest worker output cannot be written, the
restart is deferred until the worker builds again.

Each thread reports one of three patch outcomes: `applied`; `rejected`, which
retired nothing, so the old generation keeps serving and the runtime falls back
to the restart above; or `unavailable`, when the patch failed after it began
disposing the old generation (a throwing dispose callback, an updated worker
that declares `reload: 'thread'`, a replacement that failed to start or changed
the upstream list) or the worker never answered it, so recovery restarts the
runtime from the current output at once. If
that restart fails too, the runtime stays failed and unready without ending
`neem dev` until its next successful build restarts it. A crashed watcher
restarts on its own and restarts the runtimes from its fresh build.

Plugin entries and the logger run in the `neem dev` process, and ESM never
evicts a loaded module, so development builds emit them under content-hashed
file names: a restart imports the rebuilt file by its new path, while the
previous instances stay in memory until the process exits.

Watching uses native file-system events. Set `build.watch.usePolling: true` in
`neem.config.ts` (with an optional `pollInterval`, milliseconds, Rolldown's
default is 100) to poll instead; it costs CPU per watched module but has no
gap in which an edit can go unreported, which native watching on macOS
currently has right after a rebuild.

Modules re-executed by a patch can register `import.meta.hot.dispose(callback)`
to release module-level timers or listeners; the callback receives
`import.meta.hot.data`, which the next instance of the module sees. Only
self-accepting boundaries are supported.

Use `defineRuntimeWorker({ definition, createRuntime, reload: 'thread' })` when
every edit needs that runtime restart with fresh threads. The default is
`reload: 'generation'`; `stop()` must release the generation's resources before
its replacement can start.

`build.updates.maxPatches` limits accepted patches per thread (default `50`).
After that many patches, the next update restarts the runtime from fresh
output. Set it to `0` to restart on every update. Production workers are
created directly and their bundles contain no DevEngine instrumentation.

## Shutdown

`neem start`, `neem dev` and a built `start.js` stop within one total budget,
`lifecycle.stopTimeout` in `neem.config.ts` (milliseconds, default `15000`).
Host `stop()` hooks, runtime hosts, workers and plugins share it: each step
gets what earlier steps left over. Anything still running when the budget runs
out is terminated.

Before a worker, host runner or the host itself exits, it flushes its logger
within what is left of that budget, so asynchronous destinations keep the
shutdown logs. A crashing thread gets a best-effort flush of up to one second.

A shutdown that fails exits with a non-zero code: a cleanup step that throws,
or a worker or host runner that had to be terminated. `lifecycle.startTimeout`
(default `30000`) bounds how long a worker may take to become ready.

## Development environment files

Load an environment file before evaluating `neem.config.ts` and starting workers:

```sh
neem dev --env-files ../../.env
```

For multiple files, use a comma-separated list:

```sh
neem dev --env-files .env.local,../../.env
```

Paths are relative to the working directory, including when using `--config`.
Existing process environment variables take precedence, followed by the first
file defining a variable. Files are loaded using
[@dotenvx/dotenvx](https://dotenvx.com/docs/sdk/config), which supports variable
expansion and encrypted values. Missing files or decryption errors fail startup.

Files are loaded once; restart `neem dev` after changing them. Without
`--env-files`, Neem does not load environment files automatically. This option is
only available on `dev`; `build` and `start` use their existing environment.

When launched with Bun, Bun loads environment files before Neem starts. Those
values count as existing process variables and take precedence over `--env-files`.
Bun also loads `.env.local` in development, but skips it with `NODE_ENV=test`.

`NeemConfig.env` remains an inline environment map included in the manifest.

## Verification

```sh
vp env exec -- pnpm --filter @nmtjs/neem run test:unit --reporter=agent
vp env exec -- pnpm --filter @nmtjs/neem run test:e2e --reporter=agent
vp env exec -- pnpm --filter @nmtjs/neem run test:stress --reporter=agent
```

Unit tests cover shared build contracts and Effect ownership, clocks, schemas,
transport cancellation, and recovery. End-to-end tests exercise the canonical CLI,
packaged applications, reloads, proxy readiness, and shutdown. Stress tests exercise
repeated reloads and resource cleanup.
