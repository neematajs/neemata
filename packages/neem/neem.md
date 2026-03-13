# Neem Technical Spec (Draft)

## Purpose

`@nmtjs/neem` is a framework-agnostic application server runtime.

Primary goal:
- decouple application-server concerns (worker lifecycle, Vite orchestration, HMR coordination, proxying/load balancing) from framework runtime implementation details.

Non-goal:
- modify or break existing `nmtjs` package behavior during early iteration.

---

## Core Architecture Principles

1. **Unified application model**
   - Neem has no concept of "neemata app" vs "custom app".
   - Everything is an `application` that satisfies one typed contract.

2. **Adapter-based runtime**
   - Framework-specific logic lives in adapters.
   - Neem host runtime only orchestrates lifecycle and infrastructure.

3. **Plugin-driven extensibility**
   - Plugins are framework-agnostic extension units integrated via hookable lifecycle hooks.
   - Build metadata is provided from plugin config (`plugin.build.entrypoints(ctx)`).
   - CLI commands are first-class application-level concepts.

4. **Per-app Vite orchestration (DX-first)**
   - In dev, each app gets its own Vite server/environment.
   - In build, each app is built independently.
   - Memory use and duplicate dependency prebundling/building are accepted tradeoffs.

5. **Shared + per-app Vite config merge**
   - Neem supports host-level common Vite options.
   - Each app can provide app-specific Vite config.
   - Effective config is merged via Vite `mergeConfig`.

---

## Why Per-App Vite (instead of one shared Vite server)

### Pros
- App-level autonomy: each app can define plugins, aliasing, resolve/build settings.
- Better isolation: failures/HMR invalidation are scoped to an app.
- Cleaner framework-agnostic host boundary.
- Easy mental model: one app -> one dev graph.

### Cons (accepted)
- Higher RAM usage in dev due to multiple Vite instances.
- Potential duplicate prebundle/build work across apps.

Decision:
- keep this tradeoff; prioritize DX and architectural decoupling over global optimization in v1.

---

## Current Neem Draft Surface (implemented)

- Unified application types and adapters in `src/runtime/types.ts` and `src/runtime/application.ts`.
- Server config builder in `src/runtime/server/config.ts`.
- Copied/adapted generic server internals from nmtjs:
  - lifecycle, error policy, worker pool, managed worker, proxy orchestration, application pools.
- Initial `NeemServer` orchestrator in `src/runtime/server/server.ts`.
- Bootstrap helper in `src/runtime/server/bootstrap.ts`.
- Minimal CLI `start` in `src/cli.ts`.

---

## Planned Target Contracts

### Application contract
- `defineApplication({ adapter, definition })`
- `adapter` provides runtime creation and (optional) dev/build capabilities.

### Adapter contract (target shape)
- runtime capability:
  - create app worker runtime
  - optional reload support
- dev capability (optional):
  - create/manage app Vite dev server
  - expose app-specific HMR signals
- build capability (optional):
  - run app build with merged (common + app) Vite config

### Plugin contract
- agnostic, hook-based runtime lifecycle integration
- runtime hooks are executed through neem hook bus (`hookable`)
   - `server:setup`
   - `server:start`
   - `server:stop`
   - `server:dispose`
- plugin-owned worker communication (Neem provides worker lifecycle only; no built-in task RPC/message contract)
- one worker pool is allocated per plugin runtime instance (v1)
- build metadata is config-driven (not runtime hook execution):
   - `plugin.build.entrypoints(ctx)`

### Commands contract (first-class)
- commands are declared directly in application definitions
- commands are orchestrated by Neem CLI/runtime (not injected through plugins)

### Plugin build entrypoints contract (target)
- plugins may declare additional buildable runtime units (for example plugin workers)
- neem build pipeline discovers plugin entrypoints and bundles them as first-class artifacts
- neem start/runtime resolves plugin runtime units through a generated build manifest

### Pool-first Vite orchestration (v1 draft)
- every worker pool is Vite-powered in development (applications and plugin pools)
- each pool owns exactly one Vite dev environment/server instance
- workers spawned in a pool bind to that pool's Vite environment
- HMR invalidation/restarts are pool-scoped (no global worker restart)

Conceptual shape:
- `application -> application pool -> vite env`
- `plugin(instance by index) -> plugin pool -> vite env`
- one-pool-per-plugin-instance in v1 remains intact

Proposed contracts:

```ts
type NeemPoolId = string

type NeemPoolKind = 'application' | 'plugin'

type NeemPoolViteConfig = {
   config?: UserConfig
   // Future: if needed, add dedicated environment options from Vite API
}

type NeemPoolDescriptor = {
   id: NeemPoolId
   kind: NeemPoolKind
   owner: string // app name or plugin pool name
   vite: NeemPoolViteConfig
}

type NeemPoolEnvironmentHandle = {
   poolId: NeemPoolId
   server: ViteDevServer
   environmentName: string
   stop: () => Promise<void>
}

type NeemPoolEnvironmentOrchestrator = {
   ensurePoolEnvironment: (
      descriptor: NeemPoolDescriptor,
   ) => Promise<NeemPoolEnvironmentHandle>
   getPoolEnvironment: (poolId: NeemPoolId) => NeemPoolEnvironmentHandle | undefined
   stopPoolEnvironment: (poolId: NeemPoolId) => Promise<void>
   stopAll: () => Promise<void>
}
```

Implementation draft:
- `src/runtime/vite-orchestrator.ts` provides `VitePoolOrchestrator` implementing `NeemPoolEnvironmentOrchestrator` without server wiring yet.

Lifecycle expectations:
- when a pool is created, Neem resolves/creates a Vite environment for that pool
- when a worker is spawned in a pool, worker bootstrap receives pool environment metadata
- on pool HMR update, only workers in that pool are restarted
- on pool disposal, pool workers stop first, then pool Vite environment is stopped

> TODO: define plugin/application channel orchestration contract in a separate phase.
> For now channels are intentionally out of scope for plugin API.

Conceptual shape:
- `plugin.build.entrypoints(ctx)` resolver returning `PluginBuildEntrypoint[]`
- `PluginBuildEntrypoint` fields:
   - `id` (stable logical identifier)
   - `source` (module specifier/path)
   - `target` (`worker` | `server` | `cli`)
   - optional `vite` override

### Proposed Types (draft)

```ts
type NeemRuntimeTarget = 'worker' | 'server' | 'cli'

type PluginBuildEntrypoint = {
   id: string
   source: string
   target: NeemRuntimeTarget
   vite?: UserConfig
}

type NeemPluginContext = {
   mode: 'development' | 'production'
   workers: {
      spawn: (options: {
         id?: string
         name: string
         path?: string
         type?: WorkerType
         workerData?: Record<string, unknown>
         ports?: Record<string, MessagePort>
         workerOptions?: Partial<WorkerOptions>
      }) => Promise<{
         id: string
         name: string
         type: WorkerType
         path: string
         getState: () => WorkerState
         isHealthy: () => boolean
         stop: () => Promise<void>
      }>
      stop: (workerId: string) => Promise<boolean>
      get: (workerId: string) => unknown
      list: () => unknown[]
      stopAll: () => Promise<void>
   }
}

type NeemPlugin = {
   name: string
   hooks?: {
      'server:setup'?: (ctx: NeemPluginContext) => Promise<void> | void
      'server:start'?: (ctx: NeemPluginContext) => Promise<void> | void
      'server:stop'?: (ctx: NeemPluginContext) => Promise<void> | void
      'server:dispose'?: (ctx: NeemPluginContext) => Promise<void> | void
   }
   build?: {
      entrypoints?: (
         ctx: { mode: 'production' },
      ) => Promise<PluginBuildEntrypoint[]> | PluginBuildEntrypoint[]
   }
}

type NeemBuildManifest = {
   version: 1
   applications: Record<
      string,
      {
         entry: string
         format?: 'es' | 'cjs'
         assetsDir?: string
      }
   >
   plugins: Record<
      string,
      {
         entrypoints: Record<
            string,
            {
               entry: string
               target: NeemRuntimeTarget
            }
         >
      }
   >
}
```

Notes:
- Plugin/app channel orchestration is intentionally out of scope for this phase.
- Plugin workers communicate through plugin-defined channels (for example transferred `MessagePort`s passed to `workers.spawn`).
- Build step reads only server/plugin config metadata and does not execute runtime server hooks.

---

## Execution Model (target)

### Development
1. Neem loads server config + app registry.
2. Neem starts one Vite server/environment per pool (application pools + plugin pools).
3. Workers are spawned under pools and bind to their pool Vite environment channel.
4. HMR updates are routed pool-locally, then failed workers for that pool are restarted.

### Production / Start
1. Neem starts workers from built artifacts / resolvable app specifiers.
2. No Vite server required at runtime.
3. Proxy and plugins are started by host lifecycle.

### Build
1. Neem resolves all apps.
2. For each app, run independent `viteBuild` with merged config:
   - `mergeConfig(neem.vite.common, app.vite)`
3. Neem resolves plugin-provided build entrypoints and builds them independently.
4. Emit a runtime build manifest with logical id -> output artifact mapping.
5. Collect outputs per app and per plugin runtime unit.

### Build manifest (target)

Manifest is produced by `neem build` and consumed by `neem start`.

Responsibilities:
- map app entrypoints to built outputs
- map plugin runtime units (for example plugin workers) to built outputs
- provide deterministic runtime lookup without re-resolving source modules

Conceptual structure:
- `applications[appName] = { entry, assetsDir?, format? }`
- `plugins[pluginName].entrypoints[entrypointId] = { entry, target }`

---

## Open Design Questions

1. Where should app registry/types generation live for Neem (`.neem/types.d.ts` analog)?
2. How should worker runtime bootstrap receive app-specific Vite channel metadata?
3. Should app builds run fully parallel by default, or with a configurable concurrency cap?
4. What is the minimum required adapter contract for v1 (runtime-only vs runtime+dev)?
5. Should CLI expose explicit `dev`, `build`, `start` immediately or keep incremental rollout?
6. Should plugin entrypoint build failures be isolated (skip plugin) or fail the full build by default?
7. What compatibility contract should the build manifest have across minor versions?

---

## Incremental Plan

### Phase 1 (now)
- Stabilize unified contracts and server orchestration internals.
- Keep CLI minimal.

### Phase 2
- Introduce per-app Vite manager in Neem runtime.
- Bind workers to app-specific environment channels.

### Phase 3
- Add per-app build pipeline (`viteBuild` per app).
- Add common+app config merge semantics.

### Phase 4
- Adapter package(s), including nmtjs adapter.
- Optional domain-specific plugin packages.

---

## Decision Log

- Unified application-only model: **accepted**.
- No host-level special casing for "custom" apps: **accepted**.
- Per-app Vite servers/environments in dev: **accepted**.
- Per-app build and duplicate dep work acceptable: **accepted**.
- Do not alter `nmtjs` package while drafting `neem`: **accepted**.
- Commands are first-class; plugins remain infrastructure-oriented: **accepted**.
- Plugins may define extra runtime build entrypoints; neem orchestrates build + manifest resolution: **accepted**.
- Plugin runtime instance identity uses plugin registration array index in v1 (config changes imply full restart): **accepted**.
- Universal Vite-in-dev strategy: every pool is Vite-powered and owns one Vite environment in v1: **accepted**.
