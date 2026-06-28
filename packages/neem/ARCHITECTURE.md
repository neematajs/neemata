# Neem Architecture

This document describes the new `@nmtjs/neem` architecture. It is intentionally
v2-first: legacy implementation details are only mentioned where they define a
boundary or explain why the new boundary exists.

## Goals

- Keep Neem generic: build artifacts, run named runtimes, manage lifecycle,
  health, proxying, and development reloads.
- Keep application behavior outside Neem. Neem must not own routers, jobs,
  event semantics, metrics semantics, dependency injection, transports, or
  framework-specific build output.
- Treat every deployable unit as a runtime: APIs, jobs, schedulers, event
  consumers, metrics endpoints, bots, and custom workers use the same
  orchestration path.
- Use build output and manifest metadata as the runtime source of truth.
  Production start must not import `neem.config.ts`.
- Use worker-thread isolation for development services by default. The CLI main
  thread supervises services but does not import user config, plugins, loggers,
  runtime hosts, or application code.
- Prefer explicit lifecycle ownership over hidden compatibility layers.

## Package Layout

```text
packages/neem/src
  public/
    artifact.ts
    config.ts
    hooks.ts
    index.ts
    runtime.ts
    worker.ts

  internal/
    build/
    host/
    manifest/
    plugins/
    shared/
    standalone/
    worker/

  internal-legacy/
    build/
    commands/
    runtime/

  cli.ts          # v2 target
  cli-legacy.ts  # legacy CLI while v2 is incomplete
```

`public/` is the stable public surface. `internal/` is the new implementation.
`internal-legacy/` and `cli-legacy.ts` preserve the old implementation as a
reference and fallback while v2 is built. New architecture work should target
`internal/`; do not grow legacy internals.

## Public Config Shape

Neem config is declarative. It may compose runtime helper functions and build
options, but it must not open runtime resources.

```ts
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  proxy: {
    hostname: '127.0.0.1',
    port: 3000,
    runtimes: {
      neemata: { routing: { default: true } },
    },
  },
  runtimes: [
    './apps/neemata/src/runtimes/neemata/neem.runtime.ts',
    './apps/neemata/src/runtimes/jobs/neem.runtime.ts',
    './apps/neemata/src/runtimes/events/neem.runtime.ts',
  ],
})
```

Important rules:

- `runtimes` is an array of runtime project entries: file paths, folder paths,
  globs, and negated globs.
- Runtime declaration files default-export a branded declaration from
  `defineRuntime` or a package `create*Runtime` helper.
- Runtime names come from explicit declaration `name` or nearest
  `package.json#name`; duplicate names fail.
- Raw runtime config shape is:

```ts
defineRuntime({
  name?,
  planner?,
  worker: { entry, build? },
  host?,
})
```

- Runtime/build entries are string or URL module specifiers resolved from the
  runtime declaration file.
- Package specifiers such as `@playground/neemata` are valid.
- Runtime helper functions own their public input shape. Neem owns only the
  generic runtime declaration they return.

## Core Concepts

### Runtime

A runtime is a named deployment unit. It may have:

- one worker entry;
- optional runtime host entry;
- required runtime planner entry;
- returned upstreams.

Neem interprets only lifecycle state and returned upstreams. Package-specific
protocols remain package-owned.

### Runtime Worker

Runtime workers run user/runtime code in worker threads. Worker entries
default-export a Neem worker object that creates a runtime instance:

```ts
export type NeemRuntime = {
  start: () => MaybePromise<
    | readonly NeemRuntimeUpstream[]
    | { upstreams?: readonly NeemRuntimeUpstream[] }
    | undefined
  >
  stop: () => MaybePromise<void>
}
```

Workers receive:

- mode;
- runtime name;
- thread name;
- thread data;
- resolved artifact registry;
- logger metadata;
- a `MessagePort` for package-owned protocols.

### Runtime Host

A runtime host is package-owned coordination code for one runtime. It receives
planned worker handles and coordinates protocols over thread ports. Jobs are
the key example: the host owns BullMQ queue workers and dispatches work to
Neem-owned runner threads.

Target host contract:

```ts
export type NeemRuntimeThreadHandle = {
  name: string
  port: MessagePort
}

export type NeemRuntimeHost = {
  start?: () => MaybePromise<void>
  stop?: () => MaybePromise<void>
}
```

Thread handles are transport handles only. Hosts do not stop workers directly.
Neem owns worker creation, worker stop order, health, and restart policy.

## Isolation Model

Development uses worker-thread services:

```text
cli main thread
  WatcherService worker
  RuntimeService worker
```

The main thread:

- parses CLI args;
- owns `SIGINT` and `SIGTERM`;
- starts and stops service workers;
- sends explicit shutdown messages;
- uses `worker.terminate()` only after timeout;
- imports no user code.

Worker termination behavior was checked on Node `v24.16.0`:

- terminating a worker that created nested workers also tears down nested
  workers;
- nested workers receive no graceful signal when their parent is terminated;
- `SIGTERM`, `SIGINT`, `beforeExit`, `exit`, and `parentPort.close` handlers in
  nested workers do not run on parent termination.

Therefore every graceful stop must be explicit RPC:

```text
main -> service: stop
service -> nested units: stop
nested units -> service: stopped
service -> main: stopped
timeout -> main calls worker.terminate()
```

This isolates JS module caches and avoids orphan child processes. It does not
guarantee cleanup for process-global native leaks. The service protocol should
remain transport-neutral so a process-backed transport can be added later if
needed.

## Build And Manifest

`internal/build` owns graph resolution and Rolldown compilation.
`internal/manifest` owns manifest creation, validation, and snapshot loading.

Build output should include:

```text
dist/neem.manifest.json
dist/start.js
dist/runtimes/<runtime>/start.js
dist/runtime/worker-entry.js
runtime worker artifacts
runtime host artifacts
runtime planner artifacts
plugin/logger artifacts
```

Production start path:

```text
read manifest
resolve artifact registry
resolve logger from manifest metadata
create RuntimeService/HostController snapshot
start selected runtimes
start health/proxy subsystems
```

Production must not import original config or source build graph.

## WatcherService

`WatcherService` runs in a disposable worker and owns config import plus all
Rolldown watchers.

It has two watcher modes:

- signal watcher: detects graph invalidation, does not write output;
- artifact watcher: writes JS artifacts and returns resolved artifact metadata.

The main thread should not run Rolldown watchers directly. Current legacy code
already closes and recreates config watchers after rebuilds to contain Rolldown
watcher resource retention. In v2, that containment belongs inside
`WatcherService`, not in the CLI main thread.

Target events:

```ts
type WatcherEvent =
  | { type: 'ready'; manifestFile: string }
  | { type: 'config-invalidated' }
  | { type: 'runtime-changed'; runtimeName: string }
  | { type: 'runtime-host-changed'; runtimeName: string }
  | { type: 'plugin-changed' }
  | { type: 'logger-changed' }
  | { type: 'error'; error: SerializedError }
```

Event policy:

```text
config-invalidated
  stop RuntimeService
  stop/restart WatcherService
  start RuntimeService after watcher ready

runtime-changed
  RuntimeService reloads that runtime

runtime-host-changed
  RuntimeService reloads that runtime, including HostRunner

plugin-changed / logger-changed
  restart RuntimeService for now
```

Plugin/logger restart is intentionally conservative until those systems also
run in disposable isolates.

## RuntimeService

`RuntimeService` runs in a disposable worker and owns manifest-backed runtime
orchestration.

```text
RuntimeService worker
  HostController
    HealthProbe
    ProxyController
    PluginEnvironment
    RuntimeController(name)
      HostRunner worker
      ThreadController[]
```

Responsibilities:

- load manifest-backed snapshot;
- start/stop health and proxy subsystems;
- register plugin hooks from manifest metadata;
- create one `RuntimeController` per selected runtime;
- serialize start/reload/stop operations;
- report health to the main thread if needed;
- never import source config.

## RuntimeController

Each `RuntimeController` owns one named runtime.

Startup order:

```text
start HostRunner if host exists
HostRunner imports and runs planner
resolve thread topology
start ThreadController workers
collect upstreams
transfer MessagePorts to HostRunner
HostRunner imports host and calls host.start()
mark runtime ready
```

Stop order:

```text
host.stop()
stop ThreadController workers
stop HostRunner
clear upstreams
mark runtime stopped
```

Reload order:

```text
stop current runtime
start replacement runtime
sync proxy upstreams
emit runtime reload hook
```

Failure rule:

- host failure restarts the whole runtime;
- worker failure restarts the whole runtime in the first implementation;
- partial worker restart can be considered later, but jobs/eventing host state
  is coupled to worker ports, so full runtime restart is safer and simpler.

## HostRunner

`HostRunner` is a per-runtime worker that imports planner and runtime host
artifacts.

Why it exists:

- planner execution can depend on deploy-time env and package definitions;
- planner `options` must stay host-local and avoid structured clone;
- ESM has no safe native cache invalidation yet;
- reloading a host worker clears that host's JS module graph without restarting
  the whole dev service.

HostRunner RPC:

```ts
type HostRunnerRequest =
  | {
      type: 'initialize'
      hostFile: string
      plannerFile: string
      params: HostParams
    }
  | { type: 'plan' }
  | {
      type: 'start'
      threads: readonly NeemRuntimeThreadHandle[]
    }
  | { type: 'stop' }
```

`MessagePort`s for runtime thread handles are transferred to the HostRunner
during `start`.

## Zero-Thread Runtimes

V2 should support host-only runtimes.

Valid combinations:

```text
host + zero threads      valid
host + N threads         valid
no host + N threads      valid
no host + zero threads   invalid
```

Implications:

- public runtime config must allow `host` without `worker`;
- runtime readiness cannot be derived only from worker pool state;
- host factory params may contain `threads: []`;
- proxy sync with zero upstreams is valid;
- scheduler is host-only;
- jobs remains host plus worker threads.

Health should represent runtime state separately from pool state:

```text
runtime ready = host ready && all planned workers ready
pool size 0   = no worker pool, not failed
```

## Plugins And Logger

Plugins are host/build extensions, not runtimes. They may add host hooks and
build plugins, but they must not hide long-running worker ownership. Packages
that need long-running coordination should expose explicit runtime helpers.

V2 first implementation:

- plugin/logger artifact changes restart `RuntimeService`;
- plugin hook registration remains manifest-backed;
- plugin-owned resources need explicit dispose before plugin reload can become
  isolate-local;
- metrics should become a package-owned Neem plugin only after plugin dispose is
  explicit.

## Proxy And Health

Health and proxy are host subsystems owned by `RuntimeService`.

Startup should apply runtime upstreams before marking the host ready. Proxy
state should distinguish:

- configured vs disabled;
- running vs ready;
- pending upstream updates;
- failed upstream updates;
- applied upstreams.

Readiness should fail when:

- host is starting/reloading/stopping/failed;
- any required runtime is failed or not ready;
- proxy is enabled but not ready;
- health probe startup failed.

## CLI-V2

`cli.ts` should become the v2 CLI entry. `cli-legacy.ts` keeps the old CLI while
the new path is incomplete.

Commands:

- `neem build`
  - one-shot config import/build in current process is acceptable because the
    process exits after build;
  - writes manifest and standalone start entries.
- `neem start`
  - loads built manifest;
  - starts `RuntimeService` or uses the same host internals directly in
    production mode;
  - imports no source config.
- `neem dev`
  - starts main supervisor;
  - starts `WatcherService`;
  - starts `RuntimeService` after watcher ready;
  - applies watcher event policy.

V2 does not include legacy command artifacts in the first implementation.

## Implementation Order

1. Keep `internal-legacy` stable as reference only.
2. Finish `internal/build` and `internal/manifest` around the current graph and
   manifest model.
3. Add service RPC primitives for worker-thread request/response, event stream,
   stop, and timeout handling.
4. Implement `WatcherService` with signal/artifact watcher modes.
5. Implement `RuntimeService` around `HostController`.
6. Move runtime host execution into `HostRunner`.
7. Add zero-thread runtime support and convert scheduler to host-only.
8. Add `cli.ts` v2 supervisor and keep `cli-legacy.ts` available until v2 dev
   reaches parity.
9. Wire package exports/bin to v2 after build/start/dev are all covered.

## Non-Goals

- Vite-style HMR.
- Runtime command subsystem.
- Generic capability registry.
- Neem-owned jobs, eventing, pub/sub, or metrics semantics.
- Compatibility shims for old internal imports.
