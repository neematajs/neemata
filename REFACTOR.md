# Neem Refactor Plan

This file tracks current architecture decisions and remaining porting work.

## Goals

- Move process/server infrastructure into `@nmtjs/neem`.
- Keep Neem generic: build artifacts, run named runtimes, manage host
  lifecycle, proxying, and health.
- Keep framework behavior outside Neem: Neemata API runtime, jobs, pub/sub,
  metrics, adapters, routers, validation, DI semantics, and transports.
- Make every deployable unit a runtime. Apps, jobs, schedulers, event
  consumers, bots, and custom workers all use the same host orchestration path.
- Treat Neem as an intelligent runtime orchestrator, not an app/plugin-specific
  server.
- Use Rolldown as the v1 build/watch backend.
- Use rebuild + worker recycle for dev. No Vite-style in-process HMR.
- Leave `packages/nmtjs` untouched during this Neem slice. No imports, exports,
  wrappers, compatibility shims, or migration edits there. Replace or thin it
  only after Neem runtime architecture is finished.

## Package Topology

- `@nmtjs/neem`: generic host, CLI, build/dev/start, manifest, artifact graph,
  runtime worker orchestration, optional proxy orchestration.
- `@nmtjs/application`: Neemata app model and Neem adapter.
- `@nmtjs/jobs`: BullMQ-backed jobs package and Neem runtime adapter.
- `@nmtjs/pubsub`: pub/sub manager, adapters, app runtime plugin.
- `@nmtjs/eventing`: typed durable event stream contracts, adapters, app
  producer plugin, and Neem consumer runtime.
- `@nmtjs/metrics`: future runtime/host observability package.
- `@nmtjs/proxy`: proxy implementation, optional peer used by Neem.
- `nmtjs`: legacy umbrella package. Do not update in this slice; it stays as-is
  until Neem is finished and can replace it cleanly.

`@nmtjs/neem` must not own Neemata routers, procedures, jobs, pubsub,
metrics semantics, store adapters, or app DI provisions.

## Locked Decisions

- Breaking refactor is allowed. No legacy config compatibility loader for now.
- Public Neem exports stay narrow: `@nmtjs/neem`, `@nmtjs/neem/cli`,
  `@nmtjs/neem/internal`.
- `neem` is the only CLI binary in this slice.
- Config syntax uses direct default-exported `defineConfig(...)` and declarative
  string/URL entries:
  `entry: './x.ts'`, `build: './x.build.ts'`.
- Target config uses `runtimes: { [name]: runtimeFactory(buildOverrides?) }`
  for helper runtimes, or `defineRuntime(...)` for raw generic runtimes.
  Runtime object keys are stable build/start/deploy unit IDs.
- Runtime configs have no core `kind`. Neem only cares about entry artifacts,
  threads/options, lifecycle, health, and returned upstreams.
- Runtimes are keyed by object name. That key is the stable build/start/deploy
  selector and replaces app/plugin instance identity where possible.
- Runtime configs may provide a host artifact. Hosts run on the Neem main
  thread and can do runtime orchestration logic that cannot live inside worker
  threads.
- Runtime hosts are declarative. They return desired thread plans and never
  spawn workers directly. Neem owns thread orchestration, reloads, stop order,
  worker errors, `MessageChannel` setup, and worker health accounting.
- Host lifecycle is:
  `setup -> plan -> Neem starts planned threads -> start(handles) -> stop`.
  Hosts receive started thread handles with raw `MessagePort`s after Neem starts
  their planned threads.
- Runtime thread `MessagePort`s are transport only; Neem does not define RPC,
  schemas, request IDs, or feature semantics.
- Host logic is the replacement path for current plugin main-thread behavior.
  A host can run setup/coordination on the Neem main thread, but thread
  lifecycle always stays Neem-owned.
- Runtime helpers such as `defineNeemataRuntime(...)`,
  `defineJobsRuntime(...)`, and `defineEventingRuntime(...)` return runtime
  factories. Package authors own their public helper shape; Neem owns only the
  generic runtime config produced by the factory.
- Runtime helpers can merge package-owned build requirements with user-supplied
  `NeemRuntimeBuildOptions`. Helper-emitted artifacts remain helper-owned build
  output, not public first-class runtime config.
- Runtime entries may return upstreams from `start()`. Neem registers returned
  upstreams with the proxy; runtimes returning no upstreams stay background-only.
- Upstreams are the only runtime capability Neem interprets. No upstreams means
  background runtime. No separate `app`, `job`, `consumer`, or `plugin` kind is
  needed in core.
- CLI should support selected runtimes:
  `neem build api`, `neem start api`, `neem dev api`, and multi-select forms.
- Build output should support both whole-host and per-runtime standalone
  entrypoints:
  `dist/start.js` and `dist/runtimes/<name>/start.js`.
- Build/dev resolution uses `oxc-resolver` for package specifiers and relative
  paths.
- Build config is lazy only. Inline compiler config objects are rejected.
- Built manifests store declarative runtime options/proxy/logger metadata.
  `neem start` no longer imports a compiled config artifact.
- Logger config accepts inline logger options or a string/URL logger module
  specifier. Runtime logger objects/loaders are intentionally not config values.
- Runtime entries compile to fixed `entry` artifacts.
- Runtime-declared artifact kinds are `worker` and `module`.
- Public runtime `artifacts` config is removed. Extra helper-owned runtime
  artifacts are emitted by Rolldown through Neem's hidden build metadata and
  recorded in the manifest.
- Artifact files use `.js`, not `.mjs`.
- Manifest is internal v1: `neem.manifest.json` with relative paths and
  runtime-owned artifacts only.
- `neem build` emits `start.js` and `runtime/worker-entry.js`.
- `neem start` only consumes built output and never discovers/builds source.
- `neem dev` treats `.neem` as build-like output and keeps manifest as runtime
  source of truth.
- Runtime mode is host-provided: `start -> production`, `dev -> development`.
- Runtime worker bootstrap is package-owned file, not eval source.
- `NeemRuntimeServer` owns lifecycle state, snapshots, serialized
  operations, full reload, and scoped runtime reload. No separate lifecycle
  supervisor.
- Dev config changes trigger global reload.
- Dev runtime artifact changes reload only affected runtime pool.
- Rebuild errors keep currently running units alive.
- Replacement start failure marks affected runtime/host failed until next good
  rebuild.
- Proxy is a Neem host subsystem backed by optional peer `@nmtjs/proxy`.
- Neem host plugins are not part of the target architecture. Packages that
  need host coordination plus workers expose a runtime helper with a host entry.
- No generic capability registry or app-worker service registry in v1.
- Public health/readiness probes are Neem-owned host endpoints. They are
  configured with top-level `health`, not `proxy.healthChecks`, because proxy
  health checks are upstream-routing internals.
- Jobs stay in `@nmtjs/jobs`; target Neem integration is explicit jobs runtime,
  not hidden plugin-owned workers.
- Jobs runtime host owns queue-worker coordination on the Neem main thread and
  asks Neem to run job runner threads. It talks to those threads over runtime
  thread ports.
- Jobs intentionally use BullMQ directly for both Neemata and Neem host
  runtime. No queue adapter/backend abstraction in v1; if another real queue
  runtime appears later, refactor then.
- Jobs Redis/Valkey client factory stays owned by `@nmtjs/jobs` runtime
  lifecycle. Return duplicated connections when sharing clients elsewhere.
- PubSub stays in `@nmtjs/pubsub` as ephemeral pub/sub. Public API uses typed
  channel/event definitions with explicit channel builders; raw string channels
  stay adapter/internal only. No hash-based channel naming.
- Durable message broker semantics are future separate package/surface, not
  part of `@nmtjs/pubsub`.
- Durable eventing, if added, should become explicit runtime helper(s) for
  event consumers over durable streams/logs. Do not make it a plugin-owned
  hidden runner. Target package name is `@nmtjs/eventing`.
- Eventing should expose typed event definitions and avoid raw strings in app
  code. Adapters can still operate on raw topics/records internally.
- Eventing MVP should target `@platformatic/kafka` for Kafka-compatible
  brokers and Redis Streams for Redis/Valkey. RabbitMQ Streams can be evaluated
  later; plain Rabbit queues are not the target.
- Event consumers should run as named Neem runtimes. Neem owns threads and
  lifecycle; `@nmtjs/eventing` owns broker clients, consumer groups, handler
  dispatch, and ack/commit policy.
- Metrics should observe host/runtime events through Neem hooks and health
  snapshots. Neem core must not own Prometheus or feature-specific metrics
  semantics.
- Metrics v1 is Prometheus-compatible only. `@nmtjs/metrics` owns the endpoint,
  Pushgateway support, metric worker threads, and a package-owned Rolldown
  plugin that injects default metrics registration.
- Production worker recovery is generic Neem behavior. Post-ready worker
  failures restart with bounded attempts and backoff; exhaustion marks the
  runtime failed and host readiness false.
- Degraded runtime pools are visible in health snapshots, but degraded or
  failed runtimes make `/ready` return `503`.
- Scheduler belongs in `@nmtjs/jobs` and schedules job enqueue operations. It
  must not reintroduce hidden plugin-owned workers.
- Commands mean built CLI command artifacts. `neem run <name> ...` loads the
  built command module and passes command args through without starting a
  runtime worker.
- Logging uses configured logger for runtime layers. CLI only owns fatal
  boundary. Runtime worker labels are runtime/thread names.
- Meta-framework runtimes should keep framework build output framework-owned.
  Neem should compile/adapt thin entries and record framework output metadata
  later.

## Current Status

Wired:

- `neem build`
- `neem start`
- `neem dev`
- standalone `dist/start.js`
- internal manifest/artifact registry
- config entry resolution
- managed workers and worker pools
- runtime server lifecycle and health snapshot
- runtime scoped reload
- Neem host plugin model removed; runtime hosts replace main-thread
  coordination
- proxy lifecycle with optional `@nmtjs/proxy`
- config logger flow
- generic runtime-map config/manifest/server path
- declarative string/URL config entries
- manifest-backed runtime config for built starts; no built config import
- runtime host setup/plan/start/stop/fail path
- selected-runtime build/start/dev
- per-runtime standalone start entries
- helper-owned emitted artifacts
- runtime thread handles with raw `MessagePort`
- runtime host/thread failure cleanup contract
- runtime host cleanup remains Neem-owned even if host `fail`/`stop` handlers
  throw
- runtime worker `start()` failure cleans up partially-created runtime before
  worker exit
- public health/readiness probe server backed by `NeemRuntimeServer.getHealth()`
- runtime lifecycle observer hooks, including scoped `runtime:reload`
- manifest runtime artifact validation
- helper-emitted runtime artifacts via runtime helper build metadata
- IPC-backed lifecycle test probe for spawned CLI and standalone entries
- Rolldown watch path uses polling watcher plus initial readiness delay after
  a separate initial build

Ported packages:

- `@nmtjs/jobs`
  - app-facing job builders/router helpers/injectables
  - direct BullMQ manager and runner
  - Redis/Valkey client factory; runtime owns returned connection lifecycle
  - explicit Neem runtime host with Neem-owned runner threads
  - runner worker stop fires lifecycle dispose hook so active jobs receive abort
    signal
  - `defineJobs(...)` config helper and `defineJobsRuntime(...)` runtime helper
  - CRUD-like lifecycle hooks: `added`, `updated`, `removed`
- `@nmtjs/pubsub`
  - `PubSubManager`
  - `publish`/`subscribe`/`pubsubAdapter` injectables
  - typed `PubSubChannelContract(...)` / `PubSubEventContract(...)`
  - explicit channel builders; no option hashing or durable broker semantics
  - Redis adapter with caller-owned client
  - app runtime plugin
- `@nmtjs/eventing`
  - typed `defineEvent(...)` contracts with topic/key/payload
  - app-facing `produce` injectable and plugin
  - Redis Streams adapter
    - consumer-owned pending message recovery before new reads
    - dead-letter stream policy for poison/invalid messages
  - Kafka-compatible adapter using `@platformatic/kafka`
    - explicit consumer-group/partition concurrency documentation
  - explicit Neem eventing runtime helper and worker entry
  - in-process consumer handler retries before adapter ack/commit policy

Still incomplete:

- production-grade worker restart/backoff/degraded policy
- metrics/observability package
- jobs scheduler
- CLI commands
- meta-framework build/watch lifecycle

## Completed Runtime Hardening

### 1. Production Restart Policy

- Owner: `@nmtjs/neem`.
- Generic runtime worker recovery is Neem-owned, not app/job-specific.
- Post-ready worker crashes restart with bounded attempts and backoff.
- Restart success restores runtime readiness.
- Restart exhaustion marks the runtime failed and makes host readiness false.
- Degraded pools remain visible in health; `/ready` returns `503` while any
  required runtime is degraded or failed.

Test coverage:

- post-ready worker crash restarts with backoff
- restart success restores readiness
- restart exhaustion marks runtime failed
- degraded runtime makes `/ready` return `503`

### 2. Metrics / Observability

- Owner: `@nmtjs/metrics`.
- Prometheus-compatible v1 only.
- Host-owned observer surface over Neem hooks and health snapshots.
- Keep Prometheus endpoint and Pushgateway support outside Neem core.
- Uses Prometheus worker registry support like old `nmtjs`.
- Default metrics registration is exposed through a package-owned Rolldown
  plugin.

Test coverage:

- host lifecycle metrics update from hooks
- worker/runtime health metrics reflect current snapshots
- `/metrics` returns Prometheus text
- default metrics loader registers default metrics once
- stop cleans endpoint, push interval, and metrics workers

### 3. Scheduler / CLI Commands

- Scheduler owner: `@nmtjs/jobs`.
- Scheduler schedules job enqueue operations and does not run hidden workers.
- Commands mean built CLI command artifacts, not runtime commands in v1.

## Feature Porting Ledger

| Feature | New owner | Target | Status |
| --- | --- | --- | --- |
| Build/start/dev substrate | `@nmtjs/neem` | Generic manifest/artifact runtime with Rolldown build/watch. | `wired` |
| Runtime map | `@nmtjs/neem` | `runtimes: { [name]: runtime }` as only generic orchestration model. | `wired` |
| Runtime hosts | `@nmtjs/neem` | Main-thread setup/plan/start/stop/fail with declarative thread plans. | `wired` |
| Runtime server lifecycle | `@nmtjs/neem` | Central server with start/stop/reload/scoped runtime reload. | `wired` |
| Worker management | `@nmtjs/neem` | Managed runtime workers, pools, health, timeouts, production restart/backoff policy. | `wired` |
| Proxy | `@nmtjs/neem` + `@nmtjs/proxy` | Optional host subsystem routing returned runtime upstreams. | `partial` |
| Host plugins | none | Removed from Neem target model; runtime hosts replace worker-owning plugin behavior. | `removed` |
| Neemata runtime | `@nmtjs/application` | Generic runtime adapter over pure Neemata app runtime. | `wired` |
| Jobs | `@nmtjs/jobs` | Direct BullMQ jobs runtime + app plugin/injectables. Neem adapter uses runtime host and Neem-owned runner threads. Scheduler uses BullMQ job schedulers. | `wired` |
| PubSub | `@nmtjs/pubsub` | Pub/sub package + app runtime plugin/adapters. | `partial` |
| Eventing | `@nmtjs/eventing` | Durable stream/log client plus Neem consumer runtime. | `partial` |
| Metrics | `@nmtjs/metrics` | Prometheus host observer over Neem hooks/health, endpoint, Pushgateway, and Prometheus worker registry support. | `wired` |
| Runtime injections | app packages | Neem passes context; adapters map into app containers. | `partial` |
| Health/readiness | `@nmtjs/neem` | Host-owned public `/health` and `/ready` probes from manifest-backed config. | `wired` |
| Meta-framework runtimes | adapter packages + Neem build hooks | Framework-owned build output with thin Neem adapter artifacts. | `missing` |
| Scheduler | `@nmtjs/jobs` | Jobs-owned scheduler that enqueues jobs. | `wired` |
| Commands | `@nmtjs/neem` CLI | Built CLI command artifacts executed with `neem run`. | `wired` |
| Umbrella exports | `nmtjs` | Replace/thin after Neem lands. No changes in current slice. | `deferred` |

## Target Config Shape

```ts
import { defineConfig, defineRuntime } from '@nmtjs/neem'
import { defineNeemataRuntime } from '@nmtjs/application/neem'
import { defineJobsRuntime } from '@nmtjs/jobs/neem'
import { defineEventingRuntime } from '@nmtjs/eventing/neem'

const api = defineNeemataRuntime({
  application: './src/api.ts',
  threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
})

const jobs = defineJobsRuntime({
  config: './src/jobs.ts',
})

const events = defineEventingRuntime({
  config: './src/events.ts',
  threads: 1,
})

export default defineConfig({
  logger: './logger.ts',
  health: { hostname: '127.0.0.1', port: 3100 },
  runtimes: {
    api: api({ rolldown: { /* optional user build overrides */ } }),

    jobs: jobs(),

    events: events(),

    custom: defineRuntime({
      entry: './src/custom.runtime.ts',
      threads: 1,
      options: { foo: 'bar' },
    }),
  },
})
```

Constraints:

- Config loading may import the config file during build/dev only. Config code
  must stay declarative and must not open runtime clients/connections.
- Runtime `start` reads manifest config metadata and does not import the source
  or compiled config module.
- Runtime artifact paths come from manifest, not config thunks.
- Runtime/build entries are string/URL specifiers resolved from the config file.
- Runtime helper typing is inferred at helper call sites. For Neemata, users
  can pass a typed worker entry to `defineNeemataRuntime<TEntry>(...)` so
  `threads` are checked against the application transport options.
- Runtime object keys are unique names and become build/start/deploy selectors.
- Config code can call runtime factories and compose declarative objects, but
  must not open clients, sockets, log streams, or other runtime resources.

## Host Contracts

Runtime host entries default-export a value satisfying:

```ts
export type NeemRuntimeHost<Options = unknown> = {
  setup?(ctx: NeemRuntimeHostContext<Options>): NeemMaybePromise<void>
  plan?(ctx: NeemRuntimeHostContext<Options>): NeemMaybePromise<NeemRuntimePlan>
  start?(ctx: NeemRuntimeStartedContext<Options>): NeemMaybePromise<void>
  stop?(ctx: NeemRuntimeStoppedContext<Options>): NeemMaybePromise<void>
  fail?(ctx: NeemRuntimeFailedContext<Options>): NeemMaybePromise<void>
}

export type NeemRuntimePlan = {
  threads?: readonly NeemRuntimeThreadPlan[]
}

export type NeemRuntimeThreadPlan<Data = unknown> = {
  name: string
  artifact: string | NeemResolvedArtifact
  count?: number
  data?: Data
}

export type NeemRuntimeThreadHandle = {
  id: string
  name: string
  port: MessagePort
  stop(): Promise<void>
}
```

Host lifecycle details:

- `setup(ctx)` runs on Neem main thread before any runtime workers start.
- `plan(ctx)` returns desired worker/thread topology.
- Neem creates channels, starts workers, waits for readiness, and tracks
  failures.
- `start(ctx)` receives started thread handles and can attach protocol handlers
  to their ports.
- `stop(ctx)` runs before Neem tears down runtime-owned threads.
- `fail(ctx)` is best-effort notification after host or worker failure.

Runtime worker entries default-export a value satisfying:

```ts
export type NeemRuntimeWorker<Data = unknown, Definition = unknown> = {
  _: { data: Data; definition: Definition }
  definition: Definition
  createRuntime: (
    ctx: NeemWorkerRuntimeContext<Data, Definition>,
  ) => NeemMaybePromise<NeemRuntime>
}

export type NeemRuntime = {
  start(): NeemMaybePromise<void | { upstreams?: readonly NeemProxyUpstream[] }>
  stop(): NeemMaybePromise<void>
}
```

Default host behavior exists for simple worker-pool runtimes:

1. Build one thread plan from runtime entry + configured threads.
2. Start planned runtime workers.
3. Wait for worker readiness.
4. Collect returned upstreams.
5. Stop workers on runtime stop/reload.

Custom hosts, such as future jobs or event-consumer runtimes, can return
multiple thread plans and then use started thread ports in `start(...)`. Hosts
still do not spawn workers directly.

Host/runtime responsibility split:

- Runtime package decides what threads are needed.
- Runtime package owns protocol spoken over returned `MessagePort`s.
- Neem creates `MessageChannel`s, starts workers, wires ports, tracks health,
  stops workers, and serializes reload operations.
- Neem only inspects upstreams returned by worker runtimes. No upstreams means
  background runtime.

## Dev Flow

1. Load source config.
2. Watch config file.
3. Watch runtime host/worker artifacts and helper-emitted artifacts.
4. Write `.neem/neem.manifest.json` after each successful output.
5. Build runtime snapshot from manifest-backed config metadata.
6. Apply change:
   - config -> full `server.reload(snapshot)`
   - runtime entry/artifact -> `server.reloadRuntime(runtimeName, snapshot)`
7. On rebuild error, keep existing runtime.

Dev reload scheduler is latest-wins and debounced. Config changes supersede
pending scoped runtime reloads when needed.

Rolldown watch notes:

- Neem does an explicit initial build before runtime startup, then starts the
  Rolldown watcher.
- Current Rolldown native watch behavior was unreliable in local testing; dev
  watch currently uses polling.
- Watch readiness is delayed after the initial watcher cycle so immediate edits
  after startup are not missed.
- Rebuild result objects are closed after `BUNDLE_END`/`ERROR` to reduce native
  resource retention.

## Production Flow

`neem build`:

1. Load source config.
2. Resolve selected runtime keys, if any.
3. Build runtime host/worker artifacts.
4. Build helper-emitted runtime artifacts.
5. Write manifest.
6. Emit root `start.js` and per-runtime `runtimes/<name>/start.js`.

`neem start`:

1. Read manifest.
2. Resolve artifact registry.
3. Resolve selected runtime keys, if any.
4. Start runtime worker pools.
5. Start host health/readiness probe if configured.
6. Register returned upstreams with proxy if configured.
7. Stop in reverse: health probe, proxy, runtimes.

Standalone `node dist/start.js` follows same runtime path and injects
`dist/runtime/worker-entry.js`.

## Near-Term Agenda

1. Design framework-owned build lifecycle for Nuxt/other meta-frameworks.
2. Tighten eventing/pubsub typed contracts after runtime hardening.
3. Keep broker e2e coverage running in CI services for Redis/Kafka-backed
   packages.

## Neemata Adapter Parity Audit

Current adapter parity is acceptable for the runtime model:

- `defineNeemataWorker(application)` wraps a normal `defineWorker(...)` entry.
- Worker `definition` is the application config, so Neem worker bootstrap passes
  the same app definition to every thread.
- Thread data is `NeemataAppTransportOptions<TApplication>`, matching
  `createApp(..., { transports })`.
- `NeemataApplicationRuntime.start()` delegates directly to
  `application.start()` and returns its upstreams to Neem.
- `NeemataApplicationRuntime.stop()` delegates directly to `application.stop()`.
- Logger and mode come from `NeemWorkerRuntimeContext`, so dev/prod labels and
  lifecycle mode stay host-owned.
- `defineNeemataRuntime(...)` owns only the thin runtime adapter build concerns,
  including the uWebSockets native addon build plugin.
- The application package test covers direct `createApp(...)` lifecycle and
  root-composed router metadata, including current protocol version handling.
- Neem tests cover `defineNeemataRuntime(...)` through built runtime start.

Known parity gaps to keep out of this slice:

- No adapter-specific graceful drain policy beyond current transport/gateway
  stop behavior.
- Meta-framework adapters still need separate framework-owned build lifecycle.

## Non-Goals For Current Slice

- Vite integration
- in-process HMR
- generic host capability registry
- Neem-core-owned jobs/pubsub semantics
- command runtime
- legacy config compatibility loader
