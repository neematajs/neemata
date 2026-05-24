# Neem Refactor Plan

This file tracks current architecture decisions and remaining porting work.

## Goals

- Move process/server infrastructure into `@nmtjs/neem`.
- Keep Neem generic: build artifacts, run workers, manage host lifecycle,
  proxying, health, and host plugins.
- Keep framework behavior outside Neem: Neemata API runtime, jobs, pub/sub,
  metrics, adapters, routers, validation, DI semantics, and transports.
- Use Rolldown as the v1 build/watch backend.
- Use rebuild + worker recycle for dev. No Vite-style in-process HMR.
- Keep `nmtjs` as a future thin umbrella package, not the app-server owner.

## Package Topology

- `@nmtjs/neem`: generic host, CLI, build/dev/start, manifest, artifact graph,
  worker runtime, proxy orchestration, host plugins.
- `@nmtjs/application`: Neemata app model and Neem adapter.
- `@nmtjs/jobs`: BullMQ-backed jobs package and Neem host plugin.
- `@nmtjs/pubsub`: pub/sub manager, adapters, app runtime plugin.
- `@nmtjs/metrics`: future metrics plugin.
- `@nmtjs/proxy`: proxy implementation, optional peer used by Neem.
- `nmtjs`: future umbrella/DX exports.

`@nmtjs/neem` must not own Neemata routers, procedures, jobs, pubsub,
metrics semantics, store adapters, or app DI provisions.

## Locked Decisions

- Breaking refactor is allowed. No legacy config compatibility loader for now.
- Public Neem exports stay narrow: `@nmtjs/neem`, `@nmtjs/neem/cli`,
  `@nmtjs/neem/internal`.
- `neem` is the only CLI binary in this slice.
- Config syntax uses direct default-exported `defineConfig(...)` and static lazy
  imports:
  `entry: () => import('./x.ts')`, `build: () => import('./x.build.ts')`.
- Static discovery uses Rolldown/OXC parser utilities and `oxc-resolver`.
- Build config is lazy only. Inline compiler config objects are rejected.
- Config artifact is compiled, hashed, ESM `.js`, and externalizes discovered
  app/plugin/build lazy imports.
- App/plugin entries compile to fixed `entry` artifacts.
- Plugin-declared artifact kinds are `worker` and `module`.
- Artifact files use `.js`, not `.mjs`.
- Manifest is internal v1: `neem.manifest.json` with relative paths.
- `neem build` emits `start.js` and `runtime/worker-entry.js`.
- `neem start` only consumes built output and never discovers/builds source.
- `neem dev` treats `.neem` as build-like output and keeps manifest as runtime
  source of truth.
- Runtime mode is host-provided: `start -> production`, `dev -> development`.
- Runtime worker bootstrap is package-owned file, not eval source.
- `NeemApplicationServer` owns lifecycle state, snapshots, serialized
  operations, full reload, app reload, and plugin reload. No separate lifecycle
  supervisor.
- Dev config changes trigger global reload.
- Dev app artifact changes reload only affected app pool.
- Dev plugin entry/artifact changes reload only affected plugin runtime.
- Rebuild errors keep currently running units alive.
- Replacement start failure marks affected runtime/host failed until next good
  rebuild.
- Proxy is a Neem host subsystem backed by optional peer `@nmtjs/proxy`.
- Neem host plugins are limited host extensions: lifecycle, artifacts,
  plugin-owned workers, raw plugin-worker `MessagePort`, observer hooks.
- No generic capability registry, app-worker service registry, or plugin-to-app
  worker channel in v1.
- Jobs stay in `@nmtjs/jobs`; Neem only sees generic plugin artifacts/workers.
- Jobs intentionally use BullMQ directly for both Neemata and Neem host
  runtime. No queue adapter/backend abstraction in v1; if another real queue
  runtime appears later, refactor then.
- Jobs Redis/Valkey client factory stays owned by `@nmtjs/jobs` runtime
  lifecycle. Return duplicated connections when sharing clients elsewhere.
- PubSub stays in `@nmtjs/pubsub` as explicit-channel, ephemeral pub/sub.
  Neem does not know pub/sub semantics.
- Durable message broker semantics are future separate package/surface, not
  part of `@nmtjs/pubsub`.
- Metrics should become a Neem plugin that observes host/runtime events.
- Logging uses configured logger for runtime layers. CLI only owns fatal
  boundary. App worker label format is `Neem App/<name>:<index>`.
- Meta-framework apps should keep framework build output framework-owned. Neem
  should compile/adapt thin entries and record framework output metadata later.

## Current Status

Wired:

- `neem build`
- `neem start`
- `neem dev`
- standalone `dist/start.js`
- internal manifest/artifact registry
- config/static import discovery
- managed workers and worker pools
- application server lifecycle and health snapshot
- app scoped reload
- plugin scoped reload
- plugin lifecycle and plugin-owned workers
- proxy lifecycle with optional `@nmtjs/proxy`
- config logger flow

Ported packages:

- `@nmtjs/jobs`
  - app-facing job builders/router helpers/injectables
  - direct BullMQ manager and runner
  - Redis/Valkey client factory; runtime owns returned connection lifecycle
  - Neem host plugin and job runner worker artifact
  - CRUD-like lifecycle hooks: `added`, `updated`, `removed`
- `@nmtjs/pubsub`
  - `PubSubManager`
  - `publish`/`subscribe`/`pubsubAdapter` injectables
  - explicit channel strings; no option hashing or durable broker semantics
  - Redis adapter with caller-owned client
  - app runtime plugin

Still incomplete:

- full Neemata adapter parity audit
- production-grade worker restart/backoff/degraded policy
- HTTP health/readiness probe exposure
- metrics plugin
- scheduler/commands
- meta-framework build/watch lifecycle
- umbrella `nmtjs` export cleanup

## Feature Porting Ledger

| Feature | New owner | Target | Status |
| --- | --- | --- | --- |
| Build/start/dev substrate | `@nmtjs/neem` | Generic manifest/artifact runtime with Rolldown build/watch. | `wired` |
| Application server lifecycle | `@nmtjs/neem` | Central `NeemApplicationServer` with start/stop/reload/scoped reload. | `wired` |
| Worker management | `@nmtjs/neem` | Managed workers, pools, health, timeouts; restart/backoff later. | `partial` |
| Proxy | `@nmtjs/neem` + `@nmtjs/proxy` | Optional host subsystem routing app upstreams. | `partial` |
| Host plugins | `@nmtjs/neem` | Limited host extension model with artifacts, lifecycle, hooks, workers. | `wired` |
| Neemata runtime | `@nmtjs/application` | Neem adapter over pure Neemata app runtime. | `partial` |
| Jobs | `@nmtjs/jobs` | Direct BullMQ jobs runtime + Neem host plugin + app plugin/injectables. | `partial` |
| PubSub | `@nmtjs/pubsub` | Pub/sub package + app runtime plugin/adapters. | `partial` |
| Metrics | `@nmtjs/metrics` | Host/runtime observer plugin. | `missing` |
| Runtime injections | app packages | Neem passes context; adapters map into app containers. | `partial` |
| Health/readiness | `@nmtjs/neem` | Internal health exists; public/probe exposure later. | `partial` |
| Meta-framework apps | adapter packages + Neem build hooks | Framework-owned build output with thin Neem adapter artifacts. | `missing` |
| Scheduler | `@nmtjs/jobs` later | Deferred until jobs plugin settles. | `deferred` |
| Commands | future Neem/plugin surface | Placeholder only. | `deferred` |
| Umbrella exports | `nmtjs` | Thin DX package over scoped packages. | `missing` |

## Minimal Config Shape

```ts
import {
  defineAppConfig,
  defineConfig,
  definePluginConfig,
} from '@nmtjs/neem'

export default defineConfig({
  apps: {
    api: defineAppConfig({
      entry: () => import('./src/api.ts'),
      build: () => import('./src/api.build.ts'),
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    }),
  },
  plugins: [
    definePluginConfig({
      entry: () => import('./src/jobs.plugin.ts'),
    }),
  ],
})
```

Constraints:

- Config loading must not import app/plugin/build implementation modules.
- Runtime `start` imports compiled config only for runtime options.
- Runtime artifact paths come from manifest, not config thunks.
- App/plugin/build thunks must remain static string-literal dynamic imports.
- App/plugin typing is inferred at `defineAppConfig` /
  `definePluginConfig` call sites.

## Host Contracts

App entries default-export a value satisfying:

```ts
export type NeemApp<ThreadOptions = unknown, Definition = unknown> = {
  _: { threadOptions: ThreadOptions; definition: Definition }
  kind: string
  definition: Definition
  createRuntime: (
    ctx: NeemAppRuntimeContext<ThreadOptions, Definition>,
  ) => NeemMaybePromise<NeemRuntime>
}
```

Plugin entries default-export a value satisfying:

```ts
export type NeemPlugin<Options = unknown> = {
  name: string
  artifacts?: (
    ctx: NeemPluginArtifactContext<Options>,
  ) => NeemMaybePromise<readonly NeemArtifact[]>
  setup?: (ctx: NeemPluginContext<Options>) => NeemMaybePromise<void>
  stop?: (ctx: NeemPluginContext<Options>) => NeemMaybePromise<void>
}
```

## Dev Flow

1. Discover static config entry imports.
2. Watch config artifact.
3. Watch app/plugin artifacts.
4. Write `.neem/neem.manifest.json` after each successful output.
5. Build runtime snapshot from compiled config + manifest.
6. Apply change:
   - config -> full `server.reload(snapshot)`
   - app entry -> `server.reloadApp(appName, snapshot)`
   - plugin entry/artifact -> `server.reloadPlugin(instanceId, snapshot)`
7. On rebuild error, keep existing runtime.

Dev reload scheduler is latest-wins and debounced. Config/plugin changes
supersede pending app reloads when needed.

## Production Flow

`neem build`:

1. Discover config imports.
2. Load source config.
3. Build runtime artifacts.
4. Build config/app/plugin artifacts.
5. Build plugin-declared artifacts.
6. Write manifest.

`neem start`:

1. Read manifest.
2. Import compiled config.
3. Resolve artifact registry.
4. Start plugins.
5. Start app worker pools.
6. Start proxy if configured.
7. Stop in reverse: proxy, apps, plugins.

Standalone `node dist/start.js` follows same runtime path and injects
`dist/runtime/worker-entry.js`.

## Near-Term Agenda

1. Audit Neemata adapter parity against old app worker runtime.
2. Clean `nmtjs` umbrella exports so jobs/pubsub come from scoped
   packages.
3. Add metrics plugin package.
4. Add health/readiness probe exposure.
5. Design framework-owned build lifecycle for Nuxt/other meta-frameworks.
6. Decide scheduler placement after jobs plugin settles.

## Non-Goals For Current Slice

- Vite integration
- in-process HMR
- generic host capability registry
- plugin-to-app-worker channels
- host-owned jobs/pubsub semantics
- command runtime
- legacy config compatibility loader
