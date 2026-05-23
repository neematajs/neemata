# Neem/Nmtjs Refactor Plan

Draft status: working outline. This file is the planning surface for the next
iteration and the seed for the first implementation draft.

## Goals

- Extract the application-server host into `@nmtjs/neem`.
- Rework `nmtjs` into a thin user-facing umbrella, not a permanently frozen
  compatibility layer.
- Keep host config cheap to load: no app/runtime/compiler imports while loading
  `neem.config`.
- Remove global codegen as a requirement for type-safe app thread options.
- Move jobs/store orchestration behind a Neem plugin boundary instead of keeping
  it as generic host responsibility.
- Use Rolldown as the built-in source compiler/watch backend for now.
- Target dev reload through rebuild + worker restart, not Vite-style in-process
  HMR.

## Current Direction

### Package Topology

Target packages:

- `@nmtjs/neem`: generic host core.
- `@nmtjs/application`: Neemata application model/API pipeline, including
  helpers that produce host app objects.
- `@nmtjs/jobs`: jobs plugin for Neem. It owns its store dependency privately
  until another feature needs a shared store package.
- `@nmtjs/subscriptions`: future subscription plugin package for pub/sub
  adapters and publish/subscribe integration.
- `@nmtjs/metrics`: future metrics plugin package for metrics server and
  pushgateway integration.
- `@nmtjs/proxy`: existing proxy package used by the Neem host proxy subsystem.
- `nmtjs`: thin umbrella for user DX exports.

`@nmtjs/neem` should own process/server infrastructure:

- config loading
- host app and plugin interfaces
- config option types
- lightweight public contracts/helpers/enums through the package root export
- dev/start/build CLI
- Rolldown-based source compilation, production build, and dev watch
- artifact graph and build manifest
- worker pool lifecycle
- dev restart/reload coordination
- proxy/load-balancing subsystem backed by `@nmtjs/proxy`
- plugin lifecycle

`@nmtjs/neem` should not own Neemata-framework concepts directly:

- routers/procedures/API pipeline
- transports as Neemata app config
- jobs/job routers/job manager
- store adapters
- subscription API
- metrics collection/export API

Those should be supplied by app/helper/plugin packages.

`@nmtjs/neem` public contracts should be available from the lightweight package
root export. The root public index re-exports only public contracts/helpers and
must not execute or import the full host runtime. This keeps version compliance
easier and avoids loading internal Neem implementation when users only need
types/config helpers.

Public consumer-facing modules should live under `packages/neem/src/public`.
The current package exports are intentionally narrow: `@nmtjs/neem`,
`@nmtjs/neem/cli`, and `@nmtjs/neem/internal`. Public subpath exports such as
`@nmtjs/neem/config`, `@nmtjs/neem/app`, and `@nmtjs/neem/plugin` are not part
of the current source of truth.

### Compatibility Stance

This refactor is allowed to be breaking.

Do not preserve old `neemata.config.*`, global `Applications` typing, or old
`nmtjs` appserver internals unless they still fit the new architecture.

`nmtjs` remains important as the high-level DX package, but its implementation
should delegate to scoped packages instead of carrying the appserver itself.
Do not touch `nmtjs` in the current implementation pass; keep all executable
work focused on `@nmtjs/neem`.

Current spike status:

- The previous `packages/neem` Vite spike is reference material only.
- The new implementation should be rebuilt from scratch around the artifact +
  runtime-unit model.

## Locked Decisions

- Rolldown is built into `@nmtjs/neem` for v1 and lazy-loaded by commands that
  need compilation/watch.
- No Vite integration in the revised plan for now.
- Core primitive is **artifact + runtime unit**.
- Applications and plugin artifacts use the same artifact graph and Rolldown
  build/watch pipeline.
- Plugin executable artifacts are declared before plugin lifecycle setup.
- v1 plugin artifact kinds are `worker` and `module`.
- Commands are deferred. The concept can be reserved, but no command runtime or
  public command artifact kind is required in the first draft.
- Dev update semantics are hard restart/reload, not Vite-style in-process HMR.
  Config rebuilds remain global restarts. App entry rebuilds call
  `NeemApplicationServer.reloadApp(appName, snapshot)` and recycle only the
  affected app pool. Plugin entry/artifact rebuilds call
  `NeemApplicationServer.reloadPlugin(instanceId, snapshot)` and recycle only
  the affected plugin runtime.
- If Rolldown rebuild fails in dev, keep currently running workers alive.
- If a rebuilt artifact starts and fails, mark the affected unit failed until the
  next successful rebuild/start.
- Config changes restart the whole app host in dev. Plugin definition changes
  restart the affected plugin runtime first, with global restart as fallback if
  plugin topology changes cannot be safely scoped.
- Per-app/per-plugin compiler options should live with app/plugin entry logic,
  not inside `neem.config`.
- App and plugin entries in config are lazy static import thunks, not plain
  strings.
- The `@nmtjs/neem` root public export owns config helper typing through
  `defineConfig`, `defineAppConfig`, and `definePluginConfig`.
- App and plugin config helpers infer options from the lazy entry default export.
  They should not take app-family or plugin-family generics in normal usage.
- Invalid app/plugin entries are rejected by helper input constraints in the
  current draft.
- `defineConfig` is a host-shape helper and currently returns the broad
  `NeemConfig` shape. Entry-specific type precision lives at
  `defineAppConfig(...)` / `definePluginConfig(...)` call sites.
- Static import discovery uses Rolldown parser utilities plus Rolldown/OXC
  `Visitor` and Neem's own constrained config syntax. Rolldown `build`/`watch`
  are used after discovery for artifact compilation and dev rebuilds.
- `neem build`, production-only `neem start`, and `neem dev` are wired.
- CLI command structure uses `citty`.
- `neem build` uses `--config` and `--outDir`; output directory precedence is
  CLI `--outDir`, then config `outDir`, then `dist`.
- `neem start` uses `--outDir` only, defaults to `dist`, requires an existing
  `neem.manifest.json`, and never builds or discovers source.
- Build loads source config, source app entries, source plugin entries, and
  source build config modules with native import in this draft.
- Production and dev should both use a compiled config artifact. Config
  compilation is config-specific: it may bundle normal config helper imports, but
  it must externalize discovered lazy app/plugin/build imports so those imports
  remain lazy and are not bundled into config output.
- The config artifact has fixed id `entry`, writes ESM `.js` output under
  `outDir/config/entry`, and must use hashed filenames so re-importing config in
  dev bypasses Node's ESM module cache.
- App and plugin entry artifacts have fixed id `entry`. App/plugin-declared
  artifacts inherit app/plugin build config; artifact-level Rolldown options
  override/merge with inherited config.
- All generated ESM artifact files should use `.js`, not `.mjs`.
- Plugin entries are authoritative for plugin-declared artifacts. Artifact entry
  URLs such as `new URL('./worker.ts', import.meta.url)` resolve against source
  plugin files during build.
- Build manifest is internal and written as `neem.manifest.json` with relative
  paths.
- Production `neem build` emits standalone runtime artifacts:
  `outDir/start.js` and `outDir/runtime/worker-entry.js`. Manifest
  `runtime.entry` and `runtime.worker` record those paths as relative paths.
- Dev treats `.neem` as a build-like outDir. The dev manifest is the source of
  truth after every successful watcher output change.
- Build cleanup is scoped to Neem-owned paths under `outDir`: `config/`,
  `apps/`, `plugins/`, and `neem.manifest.json`. Unrelated files must survive.
- Dev cleanup is scoped to Neem-owned paths once at session startup. Rebuilds do
  not clean stale hashed artifacts while old workers may still import them.
- Production `start` imports compiled config only to read app thread options;
  it must not call config app/plugin/build lazy thunks.
- Production `start` builds an absolute artifact registry from manifest paths
  and passes it to app runtime contexts.
- Production app runtimes run in Node worker threads, one worker per configured
  app thread.
- Runtime mode is host-provided through worker data: `neem start` uses
  `production`; `neem dev` uses `development`.
- Runtime worker bootstrap is an internal package-built Neem artifact
  (`dist/internal/runtime/worker-entry.js`), not an eval string and not a user
  manifest artifact. It handles generic worker artifacts and app runtime
  threads through the same private worker protocol.
- First `start` failure policy is fail-fast: any bootstrap/start failure rejects
  startup and stops already-started workers; any post-start worker failure stops
  the host.
- Plugins are build-visible and present in the artifact registry. Production
  `start` wires plugin `setup`/`stop` and plugin worker registry. Dev watches
  plugin entries and plugin-declared artifacts, writes them into the same
  manifest shape, and scoped-reloads the affected plugin runtime on successful
  rebuild.
- Host/plugin boundary is **host kernel**: `@nmtjs/neem` owns lifecycle, worker
  management, artifact registry, proxy subsystem, health/readiness substrate,
  and plugin execution contracts. Feature packages own feature behavior.
- `@nmtjs/proxy` remains a package, but proxy orchestration is a Neem host
  subsystem, not a generic app/plugin feature. It is an optional peer
  dependency of `@nmtjs/neem` and is loaded only when proxy config exists.
- Jobs move to an explicit `@nmtjs/jobs` Neem plugin. Current Neem package work
  should use visible scoped plugin entries and should not design umbrella
  convenience APIs.
- Job worker task protocol is private to `@nmtjs/jobs`. Neem manages generic
  worker artifacts/lifecycle and does not understand job task semantics.
- Store stays private to `@nmtjs/jobs` until another feature needs shared store
  ownership.
- Subscriptions move to `@nmtjs/subscriptions` as a plugin package. How
  Neemata apps consume subscription APIs is deferred to the application package;
  no generic Neem capability registry is planned for this slice.
- Metrics move to `@nmtjs/metrics` as a plugin package observing host/runtime
  events.
- Neemata app plugins stay in `@nmtjs/application` as app-level runtime
  plugins. They are separate from Neem host plugins.
- Runtime injections for Neemata apps are owned by `@nmtjs/application`; Neem
  passes host runtime context and does not mutate `@nmtjs/core` provisions
  directly.
- No legacy config compatibility loader is planned. Old config fields are
  mapped into the new model only where they still fit.
- Current package export paths are `@nmtjs/neem`, `@nmtjs/neem/cli`, and
  `@nmtjs/neem/internal`.
- `neem` is the only CLI binary in the current Neem package slice. `nmtjs` or
  `neemata` binary aliases are deferred out of scope.
- Static discovery depth for v1 is default-exported direct
  `defineConfig(...)` app/plugin config declarations using static
  string-literal dynamic imports. Imported config fragments, non-default
  `defineConfig(...)` calls, and computed paths are deferred/rejected.
- Manifest schema remains internal for v1. No public manifest type/export is
  committed yet.
- Plugin/module artifact consumers receive resolved artifact records/file paths
  through the artifact registry for v1. A higher-level import helper is deferred.
- Public build config shape is an opaque Rolldown option pass-through
  (`NeemRolldownOptions`). Neem stabilizes where config lives and how base
  options merge with artifact options, not the full Rolldown schema.
- Build config is lazy only: `build: () => import('./x.build.ts')`. Inline
  build objects are rejected so config loading does not execute compiler plugin
  code.
- Managed worker substrate now exists in `@nmtjs/neem` internals with state
  tracking, startup timeout, stop timeout, restart helper, failure count, and
  health snapshot. App workers use it.
- Worker pool substrate now exists in `@nmtjs/neem` internals with grouped
  start/stop/restart, aggregate state, and health counts. App threads are
  grouped by app pool. Backoff/degraded production policy remains future work.
- Host health snapshot now exists on `NeemApplicationServer.getHealth()` and
  `startNeem().getHealth()`. It reports lifecycle state/readiness, app pool and
  worker health, plugin state/last error/worker health, proxy state, and
  upstreams. HTTP probe exposure remains future work.
- Centralized application server direction is now preferred over a separate
  lifecycle supervisor. `NeemApplicationServer` owns runtime snapshot state,
  serialized operations, and lifecycle states:
  `idle`/`starting`/`running`/`reloading`/`failed`/`stopping`/`stopped`.
- `NeemApplicationServer.reload(snapshot)` is a full stop/start of plugins and
  app pools and remains the config-change path. `reloadApp(appName, snapshot)`
  replaces one app worker pool. `reloadPlugin(instanceId, snapshot)` replaces
  one plugin runtime. Both scoped paths reuse the serialized operation queue,
  set lifecycle state to `reloading`, and mark the host `failed` if replacement
  fails.
- Runtime snapshots are now explicit internal values assembled from compiled
  config + manifest + scoped artifact registry. `start` and `dev` should both
  feed snapshots into `NeemApplicationServer` instead of each owning separate
  runtime orchestration.
- Generic reloadable worker contract now exists at the `@nmtjs/neem` root
  public export. `runtime/worker-entry.ts` is the Neem-owned bootstrap for
  plugin workers and app runtime threads.
- Production plugin lifecycle now imports built plugin entry artifacts from the
  manifest, runs `setup` before app workers start, runs `stop` after app
  workers stop, and passes typed options plus artifact registry into context.
  It does not call config plugin lazy thunks.
- Config-level logging is wired through `defineConfig({ logger })` and accepts
  either a logger instance or a lazy static logger entry. The same resolved
  logger flows through build, dev, start, plugins, app workers, and generic
  worker runtime contexts.
- Default Neem logger verbosity is mode-aware: development uses `debug`,
  production/build uses `info`. CLI success `console.log` output is removed;
  command/runtime layers log through the configured logger, while CLI keeps only
  the fatal error boundary.
- Logging verbosity should follow old `nmtjs` app-server shape: `info` for
  user-facing major phases and app transport endpoints, `debug` for grouped
  rebuild/setup details, `trace` for per-worker/pool/proxy/state churn, and
  `warn`/`error` only for policy/failure paths. Avoid double-logging the same
  action at parent and child levels.
- App worker logger labels must stay `App/<name>:<index>`; this is part of the
  readable runtime log format.
- Meta-framework app support is tracked as future build model work. Nuxt
  research shows adapter entry bundling can work, but framework build output
  should remain framework-owned instead of being replicated through Rolldown.
- Deep app-server research confirmed the split between application framework
  and runtime/platform layer. Neem should stay on the runtime/platform side:
  lifecycle, workers, proxy, health/readiness, build artifacts, dev reload, and
  limited host plugins. DI, routing semantics, validation, auth, ORM, and
  framework-specific APIs belong to app packages/adapters.
- No generic capability registry for plugin/app integration in the current
  slice. It adds dependency ordering, versioning, reload, and injection
  semantics too early. Plugins own their own resources and worker protocols.

## Feature Porting Ledger

All meaningful current `nmtjs` app-server features must be ported unless they
are explicitly replaced by an equivalent new architecture. Deprecated or WIP
features are tracked as `deferred`, not removed. Vite-specific implementation
details are not parity requirements; equivalent dev rebuild/restart behavior is.

Status values:

- `wired`: current Neem draft already has usable behavior.
- `partial`: current Neem draft has contract or substrate, but not full parity.
- `missing`: no meaningful Neem runtime behavior yet.
- `deferred`: intentionally tracked for later after prerequisite architecture
  lands.

| Feature | Current owner | New owner | Target shape | Current decisions | Status |
| --- | --- | --- | --- | --- | --- |
| Neemata app runtime | `packages/nmtjs/src/runtime/workers/application.ts` | `@nmtjs/application` Neem adapter | Port `ApplicationWorkerRuntime` behind `defineNeemataApp().createRuntime()`: `ApplicationApi`, router/procedure registration, guards, filters, middlewares, meta, hooks, lifecycle hooks, Gateway, formats, transports, identity, heartbeat, and stream timeouts. | Keep Neem generic. Neemata-specific runtime stays outside `@nmtjs/neem`; adapter must satisfy Neem app/worker contracts. | `missing` |
| Build/start/dev substrate | `packages/nmtjs/src/entrypoints/*` + Vite app-server pipeline | `@nmtjs/neem` | Keep config artifact, app/plugin artifacts, standalone runtime artifacts, manifest, CLI, production start host, and Rolldown dev watchers in the generic host. | Build output and dev `.neem` use same manifest/artifact shape. Runtime difference is mode/watch/restart, not different transform semantics. Production build emits `start.js` + `runtime/worker-entry.js` for `node dist/start.js`. | `partial` |
| Worker management | `ManagedWorker`, `WorkerPool`, `ErrorPolicy` | `@nmtjs/neem` host | Reintroduce managed workers/pools with state machine, startup timeout, stop timeout, restart/backoff policy, failure counters, degraded/prod behavior, and health reports. Managed worker and pool substrates are wired for app workers; backoff/degraded policy remains. | Generic managed-worker substrate belongs to host. Runtime-specific wrappers should layer protocol handling over it instead of duplicating worker control. | `partial` |
| Server lifecycle | `ServerLifecycle`, `HMRCoordinator`, main entrypoint | `@nmtjs/neem` `NeemApplicationServer` | Keep lifecycle inside the centralized application server: runtime snapshot state, serialized operations, `start`, `reload`, `stop`, failed state, and later app/plugin partial updates. No separate lifecycle supervisor class. | No standalone lifecycle class and no inheritance. `NeemApplicationServer` owns serialized operations, revision, state, and errors directly. | `partial` |
| Health/readiness | Ad hoc process/runtime state | `@nmtjs/neem` host | Add host-level health/readiness snapshot for production operation: lifecycle state, app pool state, plugin state, worker health, proxy state, and last errors. Later expose through CLI/internal API and optional probe endpoint. | Production app-server research puts readiness/liveness/startup probes in the runtime/platform layer. Internal `getHealth()` snapshot is wired; HTTP probe exposure remains future work. | `partial` |
| Proxy | `ApplicationServerProxy` | `@nmtjs/neem` host subsystem backed by `@nmtjs/proxy` | Keep upstream tracking in Neem host, then wire add/remove upstreams, `0.0.0.0` normalization, routing, SNI/TLS, health checks, and proxy lifecycle. Upstream registry, normalization, refcounted add/remove events, and optional `@nmtjs/proxy` lifecycle are wired. | Proxy orchestration is host responsibility because it routes app upstreams. `@nmtjs/proxy` remains implementation package and optional peer; Neem lazy-loads it only when proxy config exists. | `partial` |
| Host plugins | Server subsystems and future host extensions | `@nmtjs/neem` plugin model | Make Neem plugins a limited process/host extension model: `setup`, `stop`, artifact declarations, plugin-owned workers, typed options, logger, artifact registry, observer-only host lifecycle hooks, and private plugin-to-worker messaging. Production and dev `setup`/`stop` are wired; plugin entry/artifact rebuilds scoped-reload only the affected plugin runtime. | Plugins are not a DI container, app service registry, distributed broker, or app-worker communication layer in v1. They may extend the host by owning resources/workers and observing lifecycle. Plugin semantics stay inside plugin packages. | `partial` |
| Neemata app plugins | `@nmtjs/application` `RuntimePlugin` | `@nmtjs/application` | Keep Neemata app plugins separate from Neem host plugins for app-level hooks and `@nmtjs/core` provisions. Do not fold them into generic Neem plugins. | App plugins are framework-level extension points. Host plugins are process-level extension points. Names may overlap, ownership must not. | `partial` |
| Jobs | `ApplicationServerJobs`, `JobWorkerRuntime`, `JobManager` | `@nmtjs/jobs` Neem plugin | Port as explicit first-class plugin with BullMQ queue workers, private store dependency, Io/Compute pools, job runner workers, private job task protocol, cancellation, progress/checkpoints, return handling, retries/unrecoverable errors, and Neemata integration owned outside Neem host. | Jobs are not host core. Neem supplies plugin lifecycle, workers, artifacts, logging, and health substrate; job semantics stay private to jobs plugin. | `missing` |
| Store | Server config + runtime/store package | Private `@nmtjs/jobs` implementation detail for now | Keep Redis/Valkey store client/config inside jobs until a second non-jobs consumer forces a shared store package. Subscriptions should not depend on this private path. | No shared store package until real second consumer appears. Avoid premature host capability. | `missing` |
| Subscriptions | `SubscriptionManager` in worker base runtime | `@nmtjs/subscriptions` plugin + `@nmtjs/application` integration | Port publish/subscribe adapters as explicit plugin package. Neemata app runtime owns its own future integration path. Generic Neem host does not own subscription API. | Treat pub/sub as feature behavior, not generic host state. No generic Neem capability registry in current slice. | `missing` |
| Metrics | Metrics server in app server | `@nmtjs/metrics` Neem plugin | Port metrics server and pushgateway behavior as plugin observing Neem host lifecycle, workers, and app/plugin runtime events. | Metrics observes host/runtime events. Keep extensible plugin shape instead of hardcoding metrics server into Neem core. | `missing` |
| Runtime injections | `BaseWorkerRuntime`, app plugins, job runtime | `@nmtjs/application` Neemata adapter | Neem passes runtime context; Neemata app runtime owns `@nmtjs/core` container provisions for logger, worker type, publish/subscribe, store config, job manager, and app plugins. | Neem passes typed context only. Framework adapters decide how to map it into framework containers/provisions. No generic host capability registry for now. | `missing` |
| Logging | `@nmtjs/core` logger used by app server, workers, runtimes | `@nmtjs/neem` host + adapters | Use config-provided logger across build/dev/start, host lifecycle, plugins, app workers, and generic workers. Keep major user-facing phases at `info`, grouped internals at `debug`, and worker/proxy/state churn at `trace`. | `defineConfig({ logger })` accepts direct or lazy logger. App worker labels stay `App/<name>:<index>`. CLI success output should not bypass logger. Neemata adapters receive logger via runtime context. | `partial` |
| Environment/config legacy | `neemata.config.*`, server config, Vite defines | New `neem.config.ts` + app/plugin configs + `nmtjs` umbrella exports | No compatibility loader. Map old `serverPath`, `applications`, `externalDependencies`, `env`, `logger`, `store`, `proxy`, `jobs`, `subscription`, `metrics`, and `deploymentId` into new config/app/plugin model where they still fit. | Breaking refactor. Do not add compatibility loader unless later migration pressure proves it needed. | `partial` |
| Scheduler | Jobs scheduler WIP/deprecated path | Future `@nmtjs/jobs` plugin extension | Keep tracked, but do not wire until jobs plugin exists. | Deferred because scheduler depends on final jobs plugin architecture. | `deferred` |
| Commands | Old command placeholder | Future Neem command runtime or plugin | Keep concept reserved; old runtime was not meaningfully wired. | Do not spend API budget now. Revisit after runtime/plugin model stabilizes. | `deferred` |
| Dev reload semantics | Vite HMR + module runner + failed-worker recovery | `@nmtjs/neem` Rolldown watch/restart loop | Port behavior, not Vite APIs: rebuild config/apps/plugins, update manifest, keep old workers on rebuild errors, scoped-reload affected app/plugin units, then later add failed-worker recovery and reload superseding. | No Vite. Rolldown watch writes same artifact shape as build. Config rebuilds stay global because topology/options may change. App entry rebuilds call `reloadApp`; plugin entry/artifact rebuilds call `reloadPlugin`. Rebuild errors keep current units alive. Successful replacement failures mark host `failed` while unaffected units may keep running. | `partial` |
| Meta-framework apps | Not supported by old app server as generic framework adapters | Future app adapter packages + Neem custom build model | Support frameworks such as Nuxt/Next/SvelteKit by compiling only a thin Neem adapter entry with Rolldown while delegating actual framework build output to the framework build pipeline. Manifest should record adapter artifact plus framework output metadata. | Do not replicate framework build pipelines in Neem. `emitFile` is suitable for small generated shims/assets, not whole `.output`/`.next` trees. Future build config should grow a custom build/watch lifecycle beside Rolldown options. | `missing` |

## Artifact + Runtime Unit Model

Definitions:

- Source entry: user-authored path from config or plugin/app declaration.
- Artifact: compiled executable/importable output produced by Rolldown.
- Config artifact: compiled config output used by start/dev flows; it preserves
  discovered lazy app/plugin/build imports and uses a hashed filename.
- Runtime unit: thing Neem can run from an artifact.
- Pool: one or more workers for the same runtime unit and options.
- Application: runtime unit that starts app workers and returns upstreams.
- Plugin: host extension that can declare artifacts and hook lifecycle.

Artifact declaration draft:

```ts
export type NeemArtifact = {
  id: string
  kind: 'worker' | 'module'
  entry: string | URL
  rolldown?: unknown
}
```

`worker` artifacts are executable in worker threads and managed by Neem worker
pools. `module` artifacts are compiled importable modules for plugin/app code
that needs a compiled renderer/helper but not a managed long-running worker.

Rolldown may use `emitFile` internally, and compiler plugins may emit chunks or
assets, but Neem plugins should declare host-relevant executable artifacts
explicitly instead of imperatively emitting files into the host.

## Config Model

Canonical config file:

```ts
// neem.config.ts
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
      threads: [
        {
          http: {
            listen: { hostname: '127.0.0.1', port: 3000 },
          },
        },
      ],
    }),
  },
  plugins: [
    definePluginConfig({
      entry: () => import('./src/jobs.plugin.ts'),
      options: {
        // jobs plugin config TBD
      },
    }),
  ],
})
```

Important config constraints:

- App config contains entrypoints and deployment/runtime options, not adapter
  specifiers.
- Plugin config contains entrypoints and options and should use
  `definePluginConfig(...)` for entry-derived option typing.
- Loading config must not import app runtime implementation.
- Loading config must not import app/plugin entry modules at runtime.
- Loading config must not import Rolldown compiler plugins.
- Config app/plugin entries are lazy functions containing static string-literal
  dynamic imports.
- Config discovery only recognizes the config object passed to
  `export default defineConfig(...)`. Other `defineConfig(...)` calls in the
  file are ignored.
- The compiled config preserves those lazy imports. Runtime code should not
  call app/plugin/build thunks from compiled config to discover artifacts;
  production `start` should use the manifest.
- App/plugin implementation is imported only by commands that need it:
  `neem dev`, `neem build`, `neem start`, or future command runners.
- App/plugin-specific compiler config is lazy too. If an app needs Vue SFC,
  custom data loaders, or other non-baseline compiler behavior, that build
  config belongs to the app/plugin definition, not host config execution.

Canonical app entry shape:

```ts
// src/api.ts
import { defineApplication } from '@nmtjs/application'
import { defineNeemataApp } from '@nmtjs/application/neem'

const app = defineApplication({
  // Neemata application definition
})

export default defineNeemataApp(app)
```

The entry exports an adapted value that satisfies the Neem app interface. The
Neemata adapter lives in `@nmtjs/application`. Custom apps can export their own
Neem app object as long as it satisfies the same interface.

Canonical plugin entry shape:

```ts
// src/jobs.plugin.ts
import { definePlugin } from '@nmtjs/neem'

export default definePlugin({
  name: 'jobs',

  artifacts() {
    return [
      {
        id: 'job-worker',
        kind: 'worker',
        entry: new URL('./job-worker.ts', import.meta.url),
      },
    ]
  },

  setup(ctx) {
    // production start receives mode/options/artifacts/workers in ctx
  },
})
```

Plugin entries follow the same pattern as app entries: config points at a file,
and the file default-exports a value satisfying the Neem plugin interface.
`definePlugin(...)` is a typed helper, not the only valid implementation path.

Config points at plugin entries through lazy static imports. Plugin entries can
still declare their own artifacts internally.

## Type Safety

`defineAppConfig` should be the universal Neem-owned config helper:

```ts
defineAppConfig({
  entry: () => import('./src/api.ts'),
  threads: [
    // typed from `./src/api.ts` default export
  ],
})
```

`definePluginConfig` mirrors the same pattern:

```ts
definePluginConfig({
  entry: () => import('./src/jobs.plugin.ts'),
  options: {
    // typed from `./src/jobs.plugin.ts` default export
  },
})
```

`defineAppConfig` and `definePluginConfig` should not take app-family or
plugin-family generics in normal usage. The app/plugin type is inferred from the
lazy `entry` import. If the entry default does not satisfy `NeemApp` or
`NeemPlugin`, the current draft rejects the input at the helper call.

Intent:

- Infer runtime/deployment options from the app entry's default export.
- Infer plugin options from the plugin entry's default export.
- Avoid global generated types such as old `.neemata/types.d.ts`.
- Keep `entry` as a lazy import thunk so TypeScript can infer from the imported
  default export while runtime config loading stays lazy.
- Keep app-specific typing outside the host core.
- Keep host-facing app/config types in `@nmtjs/neem`.

For Neemata apps, inference should reuse the idea from current
`ServerApplicationConfig<T>`: unwrap application transports and map each
transport key to its factory options. Other app helpers can expose their own
deployment option type through the adapted app descriptor.

## Host/App Contract

Locked v1 host shape:

```ts
export type NeemApp<ThreadOptions = unknown, Definition = unknown> = {
  _: { threadOptions: ThreadOptions; definition: Definition }
  kind: string
  definition: Definition
  createRuntime: (
    ctx: NeemAppRuntimeContext<ThreadOptions, Definition>,
  ) => NeemMaybePromise<NeemRuntime>
}

export type NeemAppRuntime = {
  start: () => Promise<Array<{ type: string; url: string }> | undefined>
  stop: () => Promise<void>
}
```

`reload(...)` is optional. App and plugin worker artifact rebuilds should prefer
runtime `reload({ reason: 'artifact' })`; missing reload falls back to a harder
worker/runtime recycle in a later slice.

The `_` property is phantom type metadata used for stable option inference.
`defineApp(...)` may omit it from the runtime object and cast/freeze the final
value.

V1 decisions:

- Minimum `NeemApp` surface is `kind`, `definition`, and `createRuntime(ctx)`.
  `_` is type metadata only.
- Runtime creation stays direct through `createRuntime(ctx)`. No adapter
  indirection is added to the generic host contract for v1.
- App config entry automatically becomes the app's fixed `entry` artifact.
  Custom app-declared child artifacts are deferred; use plugins for extra
  managed executable artifacts until that need is proven.
- Upstream shape remains minimal and proxy-oriented:
  `{ type: string; url: string }`. Proxy subsystem will later decide which
  upstream `type` values it understands.

## Plugin Direction

Neem plugins are host extensions, not compiler plugins.

Plugin responsibilities may include:

- declaring executable/importable artifacts
- hooking host lifecycle
- spawning managed workers from declared artifacts
- owning resources required by the plugin
- communicating with plugin-owned workers through raw `MessagePort`s

Current `nmtjs` jobs/server responsibilities should move behind a plugin:

- store connection config
- BullMQ queue worker orchestration
- job worker pools
- job/task API integration owned by `@nmtjs/jobs` and `@nmtjs/application`
- job router support through packages outside the generic Neem host

Jobs plugin registration should be explicit in `neem.config`:

```ts
definePluginConfig({
  entry: () => import('@nmtjs/jobs/plugin'),
  options: {
    // typed from the jobs plugin default export
  },
})
```

Current Neem package scope uses visible scoped plugin entries. Hidden
auto-registration and umbrella-package convenience helpers are deferred.

Host should only know:

- plugin entrypoint
- plugin config/options
- plugin-declared artifacts
- plugin lifecycle hooks
- observer-only host lifecycle hooks
- generic worker/module artifact execution
- plugin-owned worker message ports

Host should not know job queue/task semantics. `@nmtjs/jobs` owns the private
task protocol between jobs plugin workers and job runner workers. Neem only
provides artifact resolution, worker lifecycle, host events/logging, and future
health reporting. `@nmtjs/application` and feature packages own any app-facing
integration.

Host plugins are not a general app service registry, DI module, distributed
broker, or app-worker communication layer in v1. Plugin-to-app-worker channels
and a typed capability registry are explicitly deferred.

Plugins may observe host lifecycle through `ctx.hooks`. This uses
`hookable@6.1.1` nested hooks, so `addHooks({ server: { start() {} } })`
registers `server:start`. Neem exposes only registration methods (`hook`,
`hookOnce`, `addHooks`) and never exposes `callHook`, `callHookWith`,
`removeAllHooks`, or host mutation APIs to plugins. Hook callbacks are
observer-only; errors are logged and ignored. Plugin hook registrations are
owned by the plugin runtime and removed on stop/reload.

Initial observer hook set:

- `server:start`, `server:ready`, `server:reload`, `server:stop`,
  `server:fail`
- `app:start`, `app:ready`, `app:reload`, `app:stop`, `app:fail`
- `plugin:setup`, `plugin:ready`, `plugin:stop`, `plugin:fail`
- `worker:start`, `worker:ready`, `worker:stop`, `worker:fail`

`plugin:*` hooks are host observer events for plugin runtimes. A plugin should
not rely on seeing its own `plugin:setup` event because hooks are registered
during setup. It may observe later lifecycle events after registration, and
other plugins may observe each other according to config array order.

The current user-facing shape remains entry-based:

```ts
definePluginConfig({
  entry: () => import('./jobs.plugin.ts'),
  options: {
    // typed from the jobs plugin default export
  },
})
```

Future package-level convenience helpers can wrap this shape, but they must not
force Neem core to own package-specific resolution or app-framework semantics.

Minimum `NeemPlugin` surface for v1:

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

Plugin lifecycle context includes mode, plugin name, instance id, typed options,
artifact registry, and plugin worker controls. `artifacts(...)` is build-time
declaration. `setup(...)`/`stop(...)` are runtime lifecycle hooks. Production
`start` and `dev` run them. Dev scoped-reloads an affected plugin by stopping
the old plugin runtime and setting up the rebuilt one.

## Rolldown Direction

Rolldown is the v1 compiler/watch backend inside `@nmtjs/neem`.

Rolldown primitive usage:

- `rolldown/utils.parse` or `parseSync`: parse config source for Neem's
  constrained lazy import thunk syntax.
- `rolldown/utils.Visitor`: traverse the parsed ESTree program and find only
  the default-exported `defineConfig(...)` call used as the config root.
- `build`: one-shot compile production config, app/plugin entry artifacts, and
  plugin-declared artifacts.
- `watch`: dev rebuild loop for config and app artifacts; plugin artifact watch
  is deferred. Current Rolldown version may emit `END` without `BUNDLE_END` or
  output metadata, so Neem treats watch as the change signal and falls back to
  the same artifact build path when needed.
- `rolldown`: reserved for lower-level build control if `build` becomes too
  coarse.
- `rolldown/utils.transform`: not the long-term config compile path, because it
  does not give the same watch/incremental pipeline as artifact compilation.
- `defineConfig` and `minify`: not part of Neem entry discovery.

Static discovery rule:

```ts
entry: () => import('./src/api.ts')
build: () => import('./src/api.build.ts')
```

Only static string-literal dynamic imports in direct config declarations are
valid for v1 discovery. Computed paths, imported config fragments, and
non-default `defineConfig(...)` calls are rejected/deferred.

Discovery resolves both relative paths and package specifiers through
`oxc-resolver`, so config can point at workspace packages such as
`@playground/neemata` while preserving the same static import-thunk contract.

Discovery should produce resolved metadata for each app/plugin entry and lazy
build config without executing those entry modules. The loaded config object is
then matched with discovered metadata by config key.

Expected dev flow:

1. Discover static app/plugin entry imports from config source.
2. Start a config-specific Rolldown watcher that externalizes lazy
   app/plugin/build imports by specifier/resolved path. Dev re-runs discovery
   during config rebuilds so changed lazy import paths remain external.
3. Write the hashed config artifact under `.neem/config/entry`.
4. Load config from the hashed config artifact as cheap data.
5. Match loaded config objects with discovered entry metadata.
6. Start Rolldown watchers for app entry artifacts using the same artifact layout
   as production build.
7. Write `.neem/neem.manifest.json` atomically after every successful watcher
   output change.
8. Start runtime units from the current manifest with `mode: 'development'`.
9. On config rebuild success, write a new hashed config artifact, update the
   manifest, and globally restart the host because app/plugin topology and
   options may have changed.
10. On app rebuild success, update the manifest and call
    `NeemApplicationServer.reloadApp(appName, snapshot)` so only the affected
    app pool is recycled.
11. On plugin entry or declared artifact rebuild success, update the manifest
    and call `NeemApplicationServer.reloadPlugin(instanceId, snapshot)` so only
    the affected plugin runtime is recycled. Config/plugin topology changes
    still flow through config rebuild and global reload.
12. On rebuild error, keep existing running workers alive.

Expected production build flow:

1. Discover static app/plugin entry imports from config source.
2. Load source config and source app/plugin entries with native import.
3. Compile config into a hashed artifact under `outDir/config/entry` using the
   config-specific Rolldown pipeline and externalized lazy imports.
4. Build app entry artifacts with fixed id `entry`.
5. Build plugin entry artifacts with fixed id `entry`.
6. Collect plugin artifact declarations from source plugin entries so
   source-relative artifact URLs resolve correctly.
7. Build all plugin-declared artifacts.
8. Write internal `neem.manifest.json` with relative artifact/config paths,
   artifact ids, kinds, owners, app entries, plugin entries, and plugin
   artifacts.
9. Emit standalone runtime artifacts and record them in manifest
   `runtime.entry` / `runtime.worker`.
10. `neem start` imports compiled config and manifest and does not compile.

Expected production start flow:

1. Read `outDir/neem.manifest.json`.
2. Import compiled config from manifest `config.file`.
3. Resolve manifest-relative app/plugin artifact paths into absolute files.
4. For each app thread option, spawn one Node worker from the built app entry
   artifact.
5. Worker imports the app artifact, validates the default export, creates the
   runtime with host-provided mode (`production` for start), starts it, and
   reports upstreams.
6. Host waits for all workers to report ready before considering start
   complete.
7. On `SIGINT`/`SIGTERM` or host stop, send stop to workers and call runtime
   `stop()` inside each worker.
8. Standalone `node outDir/start.js` follows the same production start path,
   but injects `outDir/runtime/worker-entry.js` as worker bootstrap so built
   output can run without the Neem CLI package.

Compiler/plugin examples:

- React/TSX renderers should work through Rolldown baseline JSX/TS support.
- Vue SFC renderers can use `unplugin-vue/rolldown` from entry-owned artifact
  build options.
- CSS/assets must be accounted for in artifact output and manifest before
  claiming email/PDF renderer support.

## First Draft Slice

The first implementation draft should prove shape, not parity. The current
draft wires `neem build`, production-only `neem start`, and `neem dev`.

Build enough to answer whether the architecture works:

- Recreate `packages/neem` from scratch with lightweight exports for config,
  app, plugin, and runtime contracts.
- Add Rolldown build/watch service for app artifacts and plugin artifacts.
- Support app entries compiled to module artifacts with fixed id `entry`.
- Support plugin entries compiled to module artifacts with fixed id `entry`.
- Support plugin entries that declare `worker` and `module` artifacts.
- Support static discovery of `entry: () => import('./x')` from direct config
  app/plugin declarations.
- Wire `neem build --config <path> --outDir <path>` with `citty`.
- Compile config during build without bundling lazy imports.
- Emit ESM artifacts as `.js`.
- Clean only Neem-owned output paths.
- Write internal `neem.manifest.json` using relative paths.
- Add tests for build output, manifest path portability, Neem-owned cleanup,
  CLI build, `.js` output, non-bundled config compilation, and plugin
  source-relative artifact declarations.
- Emit standalone `start.js` and `runtime/worker-entry.js` from `neem build`,
  record relative runtime paths in manifest, and test `node outDir/start.js`.
- Wire `neem start --outDir <path>` against built output only.
- Start generic Neem apps in worker threads from built app entry artifacts.
- Use the typed package-built runtime worker entry for worker bootstrap;
  source-mode tests must build `@nmtjs/neem` first so
  `dist/internal/runtime/worker-entry.js` exists.
- Track app upstreams in the host proxy registry with normalization and
  refcounted add/remove events, and start/stop the optional `@nmtjs/proxy`
  implementation when proxy config is present.
- Preserve plugin artifacts in the runtime registry and run production plugin
  `setup`/`stop`; dev plugin lifecycle remains deferred.
- Introduce runtime snapshots and `NeemApplicationServer` as the shared runtime
  path for future `start`/`dev` unification. `start` will load a built snapshot;
  `dev` will build/watch snapshots and apply updates to the same server.
- Keep lifecycle state inside `NeemApplicationServer`; do not add a separate
  lifecycle supervisor or inheritance layer.
- Add generic worker contracts to the `@nmtjs/neem` root export and
  package-owned `runtime/worker-entry.js` for reloadable worker artifacts.
  `NeemRuntimeWorker` now wraps `NeemManagedWorker` for plugin-spawned workers;
  app workers still have a separate wrapper in `commands/start.ts` until the
  application server path fully replaces legacy start/dev orchestration.
- Wire `neem dev --config <path> --outDir <path>` with default outDir `.neem`.
- Use Rolldown `watch()` for dev config/app artifacts instead of repeated
  one-shot builds.
- Treat `.neem/neem.manifest.json` as dev runtime source of truth.
- Current dev applies config manifest changes with full server reload and app
  or plugin artifact manifest changes with scoped `reloadApp`/`reloadPlugin`.
- Keep `tests/neem` as a consumer-style package that imports `@nmtjs/neem`
  through package exports and captures what feels good or breaks in user-facing
  config/app/plugin code.

Do not include in first draft:

- Vite integration
- in-process HMR/reload
- full jobs plugin
- plugin dev lifecycle support
- metrics plugin implementation
- meta-framework custom build/watch lifecycle

## Learned From Current Attempt

Keep:

- `@nmtjs/neem` as a real host package.
- Worker-pool lifecycle and error-policy ideas.
- Lazy runtime module/build manifest idea.
- E2E coverage for plain app + dev reload + built server.

Change:

- Do not make config import app runtimes.
- Do not make config import compiler plugins.
- Do not keep plugin and command surfaces half-wired in host core.
- Do not leave jobs/store/metrics as silent omissions if claiming appserver
  parity.
- Do not require global codegen for typed server/application config.
- Replace Vite Environment/HMR architecture with Rolldown artifact rebuild +
  restart for v1.

Fix before implementation branch is considered healthy:

- `@nmtjs/neem` package metadata needs publish-ready exports and dependency
  boundaries.
- Optional peer dependencies must be honest; host must lazy-load optional
  integrations or make them required.
- Meta-framework packages such as Nuxt should own their own build outputs.
  Neem should orchestrate and record those outputs, not route framework internals
  through Rolldown `emitFile`.
- Old Vite spike should not leak public API names into the new design.

## Open Questions

No blocking Neem-package architecture questions remain for the current slice.

Deferred questions outside the current Neem-only pass:

- How much of current jobs API should be preserved after moving behavior into
  `@nmtjs/jobs`.
- Whether umbrella-package convenience helpers or CLI aliases should exist
  later.
- Whether any manifest fields should become public after runtime/plugin
  extension APIs stabilize.
- Whether module artifacts need a higher-level import helper after plugin
  runtime exists.
- Exact public shape for custom build/watch lifecycle needed by meta-framework
  adapters.
