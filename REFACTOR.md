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
- Target config uses `runtimes: { [name]: defineRuntimeConfig(...) }`.
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
- Runtime helpers such as `defineNeemataRuntime(...)` and
  `defineJobsRuntime(...)` can wrap generic runtime config. Helper-owned build
  metadata is attached through Neem's internal build symbol, not public config
  fields.
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
- Metrics should observe host/runtime events. Implementation can use runtime
  hooks or a narrow host extension, but must not introduce feature-specific host
  semantics.
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
- runtime lifecycle observer hooks, including scoped `runtime:reload`
- manifest runtime artifact validation
- helper-emitted runtime artifacts via hidden Neem build metadata

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
  - Kafka-compatible adapter using `@platformatic/kafka`
  - explicit Neem eventing runtime helper and worker entry

Still incomplete:

- full Neemata adapter parity audit
- production-grade worker restart/backoff/degraded policy
- HTTP health/readiness probe exposure
- metrics/observability package
- scheduler/commands
- meta-framework build/watch lifecycle

## Feature Porting Ledger

| Feature | New owner | Target | Status |
| --- | --- | --- | --- |
| Build/start/dev substrate | `@nmtjs/neem` | Generic manifest/artifact runtime with Rolldown build/watch. | `wired` |
| Runtime map | `@nmtjs/neem` | `runtimes: { [name]: runtime }` as only generic orchestration model. | `wired` |
| Runtime hosts | `@nmtjs/neem` | Main-thread setup/plan/start/stop/fail with declarative thread plans. | `wired` |
| Runtime server lifecycle | `@nmtjs/neem` | Central server with start/stop/reload/scoped runtime reload. | `wired` |
| Worker management | `@nmtjs/neem` | Managed runtime workers, pools, health, timeouts; restart/backoff later. | `partial` |
| Proxy | `@nmtjs/neem` + `@nmtjs/proxy` | Optional host subsystem routing returned runtime upstreams. | `partial` |
| Host plugins | none | Removed from Neem target model; runtime hosts replace worker-owning plugin behavior. | `removed` |
| Neemata runtime | `@nmtjs/application` | Generic runtime adapter over pure Neemata app runtime. | `wired` |
| Jobs | `@nmtjs/jobs` | Direct BullMQ jobs runtime + app plugin/injectables. Neem adapter uses runtime host and Neem-owned runner threads. | `partial` |
| PubSub | `@nmtjs/pubsub` | Pub/sub package + app runtime plugin/adapters. | `partial` |
| Eventing | `@nmtjs/eventing` | Durable stream/log client plus Neem consumer runtime. | `partial` |
| Metrics | `@nmtjs/metrics` | Host/runtime observer package. | `missing` |
| Runtime injections | app packages | Neem passes context; adapters map into app containers. | `partial` |
| Health/readiness | `@nmtjs/neem` | Internal health exists; public/probe exposure later. | `partial` |
| Meta-framework runtimes | adapter packages + Neem build hooks | Framework-owned build output with thin Neem adapter artifacts. | `missing` |
| Scheduler | `@nmtjs/jobs` or runtime helper later | Deferred until runtime model settles. | `deferred` |
| Commands | future runtime/helper surface | Placeholder only. | `deferred` |
| Umbrella exports | `nmtjs` | Replace/thin after Neem lands. No changes in current slice. | `deferred` |

## Target Config Shape

```ts
import { defineConfig, defineRuntimeConfig } from '@nmtjs/neem'
import { defineNeemataRuntime } from '@nmtjs/application/neem'
import { defineJobsRuntime } from '@nmtjs/jobs/neem'

export default defineConfig({
  logger: './logger.ts',
  runtimes: {
    api: defineNeemataRuntime({
      entry: './src/api.ts',
      build: './src/api.build.ts',
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    }),

    jobs: defineJobsRuntime({
      entry: './src/jobs.ts',
    }),

    custom: defineRuntimeConfig({
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
- Runtime helper typing is inferred at helper call sites.
- Runtime object keys are unique names and become build/start/deploy selectors.

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

## Production Flow

`neem build`:

1. Load source config.
3. Resolve selected runtime keys, if any.
4. Build runtime host/worker artifacts.
5. Build helper-emitted runtime artifacts.
6. Write manifest.
7. Emit root `start.js` and per-runtime `runtimes/<name>/start.js`.

`neem start`:

1. Read manifest.
2. Resolve artifact registry.
3. Resolve selected runtime keys, if any.
4. Start runtime worker pools.
5. Register returned upstreams with proxy if configured.
6. Stop in reverse: proxy, runtimes.

Standalone `node dist/start.js` follows same runtime path and injects
`dist/runtime/worker-entry.js`.

## Near-Term Agenda

1. Audit Neemata adapter parity against runtime worker behavior.
2. Add metrics/observability on generic runtime lifecycle.
3. Add health/readiness probe exposure.
4. Design framework-owned build lifecycle for Nuxt/other meta-frameworks.
5. Harden eventing runtime policies: retries, poison messages, DLQ, pending
   Redis Streams recovery, Kafka partition/concurrency docs.

## Non-Goals For Current Slice

- Vite integration
- in-process HMR
- generic host capability registry
- Neem-core-owned jobs/pubsub semantics
- command runtime
- legacy config compatibility loader
