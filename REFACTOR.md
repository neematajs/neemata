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
- `@nmtjs/jobs`: jobs/store plugin for Neem.
- `nmtjs`: thin umbrella for user DX exports.

`@nmtjs/neem` should own process/server infrastructure:

- config loading
- host app and plugin interfaces
- config option types
- lightweight public contracts/helpers/enums through separate export paths
- dev/start/build CLI
- Rolldown-based source compilation, production build, and dev watch
- artifact graph and build manifest
- worker pool lifecycle
- dev restart/reload coordination
- proxy/load-balancing integration, unless later moved behind a plugin
- plugin lifecycle

`@nmtjs/neem` should not own Neemata-framework concepts directly:

- routers/procedures/API pipeline
- transports as Neemata app config
- jobs/job routers/job manager
- store adapters
- subscription API

Those should be supplied by app/helper/plugin packages.

`@nmtjs/neem` public contracts should be available from lightweight export paths
that do not execute or import the full host runtime. This keeps version
compliance easier and avoids loading internal Neem implementation when users
only need types/config helpers.

Public consumer-facing modules should live under `packages/neem/src/public`.
Package exports such as `@nmtjs/neem/config`, `@nmtjs/neem/app`, and
`@nmtjs/neem/plugin` should point at those public modules, not at host runtime
or compiler internals.

### Compatibility Stance

This refactor is allowed to be breaking.

Do not preserve old `neemata.config.*`, global `Applications` typing, or old
`nmtjs` appserver internals unless they still fit the new architecture.

`nmtjs` remains important as the high-level DX package, but its implementation
should delegate to scoped packages instead of carrying the appserver itself.

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
- Dev update semantics are hard restart: after a successful rebuild, stop the
  affected runtime unit and start it again from the new artifact.
- If Rolldown rebuild fails in dev, keep currently running workers alive.
- If a rebuilt artifact starts and fails, mark the affected unit failed until the
  next successful rebuild/start.
- Config changes restart the whole app host in dev. Plugin definition changes
  should be global restarts once plugin dev support is wired.
- Per-app/per-plugin compiler options should live with app/plugin entry logic,
  not inside `neem.config`.
- App and plugin entries in config are lazy static import thunks, not plain
  strings.
- `@nmtjs/neem/config` owns config helper typing through `defineConfig`,
  `defineAppConfig`, and `definePluginConfig`.
- App and plugin config helpers infer options from the lazy entry default export.
  They should not take app-family or plugin-family generics in normal usage.
- Invalid app/plugin entries are rejected by helper input constraints in the
  current draft.
- `defineConfig` is a host-shape helper and currently returns the broad
  `NeemConfig` shape. Entry-specific type precision lives at
  `defineAppConfig(...)` / `definePluginConfig(...)` call sites.
- Static import discovery uses Rolldown parser utilities plus Neem's own
  constrained config syntax. Rolldown `build`/`watch` are used after discovery
  for artifact compilation and dev rebuilds.
- `neem build`, production-only `neem start`, and app-only `neem dev` are
  wired.
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
- App worker bootstrap is an internal package-built Neem artifact
  (`dist/internal/app-worker-entry.js`), not an eval string and not a user
  manifest artifact.
- First `start` failure policy is fail-fast: any bootstrap/start failure rejects
  startup and stops already-started workers; any post-start worker failure stops
  the host.
- Plugins are build-visible and present in the artifact registry, but plugin
  lifecycle and plugin worker spawning are deferred.
- First `dev` slice is app-only: plugin imports, plugin artifacts, plugin
  lifecycle, and plugin workers are skipped until a later slice.

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

| Feature | Current owner | New owner | Target shape | Status |
| --- | --- | --- | --- | --- |
| Neemata app runtime | `packages/nmtjs/src/runtime/workers/application.ts` | `@nmtjs/application` Neem adapter | Port `ApplicationWorkerRuntime` behind `defineNeemataApp().createRuntime()`: `ApplicationApi`, router/procedure registration, guards, filters, middlewares, meta, hooks, lifecycle hooks, Gateway, formats, transports, identity, heartbeat, and stream timeouts. | `missing` |
| Build/start/dev substrate | `packages/nmtjs/src/entrypoints/*` + Vite app-server pipeline | `@nmtjs/neem` | Keep config artifact, app/plugin artifacts, manifest, CLI, production start host, and Rolldown dev watchers in the generic host. | `partial` |
| Worker management | `ManagedWorker`, `WorkerPool`, `ErrorPolicy` | `@nmtjs/neem` host | Reintroduce managed workers/pools with state machine, startup timeout, stop timeout, restart/backoff policy, failure counters, degraded/prod behavior, and health reports. | `missing` |
| Server lifecycle | `ServerLifecycle`, `HMRCoordinator`, main entrypoint | `@nmtjs/neem` host | Rebuild as Rolldown-backed host lifecycle with `idle`, `starting`, `running`, `reloading`, `failed`, `stopping`, `stopped`, reload superseding, and failed-start recovery in dev. | `partial` |
| Proxy | `ApplicationServerProxy` | Undecided: `@nmtjs/neem` host subsystem or plugin-backed subsystem | Keep upstream tracking in Neem host, then wire add/remove upstreams, `0.0.0.0` normalization, routing, SNI/TLS, health checks, and proxy lifecycle. | `missing` |
| Plugins | Application runtime plugins + server subsystems | `@nmtjs/neem` plugin model | Make plugins the main extension model: `setup`, `stop`, artifact declarations, plugin-owned workers, plugin options, and runtime context. | `partial` |
| Jobs | `ApplicationServerJobs`, `JobWorkerRuntime`, `JobManager` | `@nmtjs/jobs` Neem plugin | Port as first-class plugin with BullMQ queue workers, store dependency, Io/Compute pools, job runner workers, cancellation, progress/checkpoints, return handling, retries/unrecoverable errors, and `jobManager` injection. | `missing` |
| Store | Server config + runtime/store package | Undecided: host capability or plugin-provided capability | Provide store connection lifecycle for plugins and app runtimes; required by jobs and possibly subscriptions. | `missing` |
| Subscriptions | `SubscriptionManager` in worker base runtime | Undecided: host capability or plugin | Port publish/subscribe injection and adapter config without tying generic Neem host to Neemata app internals. | `missing` |
| Metrics | Metrics server in app server | Undecided: host subsystem or plugin | Port metrics server and pushgateway behavior as extension-owned runtime capability. | `missing` |
| Runtime injections | `BaseWorkerRuntime`, app plugins, job runtime | `@nmtjs/neem` + app/plugin adapters | Port logger, worker type, publish/subscribe, store config, job manager, and app/plugin provisions through explicit runtime contexts. | `missing` |
| Environment/config legacy | `neemata.config.*`, server config, Vite defines | `@nmtjs/neem` config + app/plugin configs + `nmtjs` umbrella | Map old `serverPath`, `applications`, `externalDependencies`, `env`, `logger`, `store`, `proxy`, `jobs`, `subscription`, `metrics`, and `deploymentId` into the new config/app/plugin model. | `partial` |
| Scheduler | Jobs scheduler WIP/deprecated path | Future `@nmtjs/jobs` plugin extension | Keep tracked, but do not wire until jobs plugin exists. | `deferred` |
| Commands | Old command placeholder | Future Neem command runtime or plugin | Keep concept reserved; old runtime was not meaningfully wired. | `deferred` |
| Dev reload semantics | Vite HMR + module runner + failed-worker recovery | `@nmtjs/neem` Rolldown watch/restart loop | Port behavior, not Vite APIs: rebuild config/apps, update manifest, restart workers, keep old workers on rebuild errors, then add failed-worker recovery and reload superseding. | `partial` |

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
} from '@nmtjs/neem/config'

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
import { definePlugin } from '@nmtjs/neem/plugin'

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
    // plugin lifecycle hooks and worker spawning TBD
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
- Keep host-facing app/config types in `@nmtjs/neem`; `nmtjs` may use them but
  should not own them.

For `nmtjs` apps, inference should reuse the idea from current
`ServerApplicationConfig<T>`: unwrap application transports and map each
transport key to its factory options. Other app helpers can expose their own
deployment option type through the adapted app descriptor.

## Host/App Contract

Open draft shape:

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

`reload(...)` is not required for v1. Dev rebuilds use hard worker restart.
In-process reload can be reconsidered later as an optimization.

The `_` property is phantom type metadata used for stable option inference.
`defineApp(...)` may omit it from the runtime object and cast/freeze the final
value.

Key contract decisions still needed:

- Which minimum methods/properties `NeemApp` must expose.
- Whether app object creates runtime directly or delegates through a small
  adapter-like internal method.
- How app artifacts are declared for custom apps.
- Exact upstream type and proxyability contract.

## Plugin Direction

Neem plugins are host extensions, not compiler plugins.

Plugin responsibilities may include:

- declaring executable/importable artifacts
- hooking host lifecycle
- spawning managed workers from declared artifacts
- exposing services to app runtimes through host/plugin context

Current `nmtjs` jobs/server responsibilities should move behind a plugin:

- store connection config
- BullMQ queue worker orchestration
- job worker pools
- job manager injection into app runtime
- job router support via `nmtjs` exports

Host should only know:

- plugin entrypoint
- plugin config/options
- plugin-declared artifacts
- plugin lifecycle hooks
- generic worker/module artifact execution

Open design questions:

- Should app workers receive job manager injection through the app object or
  through host-level plugin context?
- Should job worker task protocol be a generic Neem worker message channel or
  private to `@nmtjs/jobs`?
- Should jobs plugin require explicit entry in `neem.config`, or should
  `nmtjs` app helpers auto-register it when app uses jobs?

## Rolldown Direction

Rolldown is the v1 compiler/watch backend inside `@nmtjs/neem`.

Rolldown primitive usage:

- `rolldown/utils.parse` or `parseSync`: parse config source for Neem's
  constrained lazy import thunk syntax.
- `build`: one-shot compile production config, app/plugin entry artifacts, and
  plugin-declared artifacts.
- `watch`: dev rebuild loop for config and app artifacts; plugin artifact watch
  is deferred.
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

Only static string-literal dynamic imports are valid for discovery. Computed
paths are rejected for v1.

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
   manifest, and globally restart app workers.
10. On app rebuild success, update the manifest and hard-restart affected app
    workers.
11. On rebuild error, keep existing running workers alive.
12. Plugin imports/artifacts/lifecycle are skipped in the first dev slice.

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
9. `neem start` imports compiled config and manifest and does not compile.

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

Compiler/plugin examples:

- React/TSX renderers should work through Rolldown baseline JSX/TS support.
- Vue SFC renderers can use `unplugin-vue/rolldown` from entry-owned artifact
  build options.
- CSS/assets must be accounted for in artifact output and manifest before
  claiming email/PDF renderer support.

## First Draft Slice

The first implementation draft should prove shape, not parity. The current
draft wires `neem build`, production-only `neem start`, and app-only
`neem dev`.

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
- Wire `neem start --outDir <path>` against built output only.
- Start generic Neem apps in worker threads from built app entry artifacts.
- Use the typed package-built app worker entry for worker bootstrap; source-mode
  tests must build `@nmtjs/neem` first so `dist/internal/app-worker-entry.js`
  exists.
- Track app upstreams for future proxy integration but do not wire proxy yet.
- Keep plugin lifecycle unwired while preserving plugin artifacts in the runtime
  registry.
- Wire `neem dev --config <path> --outDir <path>` with default outDir `.neem`.
- Use Rolldown `watch()` for dev config/app artifacts instead of repeated
  one-shot builds.
- Treat `.neem/neem.manifest.json` as dev runtime source of truth.
- Restart app workers from manifest changes with `mode: 'development'`.
- Keep `tests/neem` as a consumer-style package that imports `@nmtjs/neem`
  through package exports and captures what feels good or breaks in user-facing
  config/app/plugin code.

Do not include in first draft:

- Vite integration
- in-process HMR/reload
- full jobs plugin
- plugin dev/lifecycle support
- metrics redesign
- proxy redesign beyond what is needed for app upstreams

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
- Old Vite spike should not leak public API names into the new design.

## Open Questions

1. What is the minimum stable `NeemApp` interface?
2. What is the minimum stable `NeemPlugin` interface and lifecycle context?
3. How deep should static discovery go in v1? Current first-draft leaning:
   direct declarations inside `neem.config`; imported app/plugin config modules
   may require a later Rolldown transform-plugin metadata pass.
4. Which exact lightweight `@nmtjs/neem` export paths should own config/types
   versus runtime internals?
5. Should the new CLI command be only `neem`, or should `nmtjs` also keep a
   `neemata` binary as an alias during transition?
6. How much of current jobs API should be preserved after moving to
   `@nmtjs/jobs`?
7. Should metrics stay host-level or become plugin-provided?
8. Should proxy stay inside `@nmtjs/neem` or move to a host plugin too?
9. Which manifest fields should become stable/public later, if any, versus
   remaining internal to `@nmtjs/neem`?
10. Should module artifacts be imported by plugins through a host helper, or
    passed as resolved file paths?
11. What exact public shape should `build` config expose, and how much of
    Rolldown's option surface should Neem commit to forwarding?
