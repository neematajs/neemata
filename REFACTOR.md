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
- Config or plugin definition changes restart the whole Neem host in dev.
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
- `neem build` and production-only `neem start` are wired. `neem dev` remains
  reserved until the watch/restart slice.
- CLI command structure uses `citty`.
- `neem build` uses `--config` and `--outDir`; output directory precedence is
  CLI `--outDir`, then config `outDir`, then `dist`.
- `neem start` uses `--outDir` only, defaults to `dist`, requires an existing
  `neem.manifest.json`, and never builds or discovers source.
- Build loads source config, source app entries, source plugin entries, and
  source build config modules with native import in this draft.
- Production and dev should both use a transformed config module. Config
  transform is single-file and must preserve lazy app/plugin/build imports
  instead of bundling them into config output. `neem start` should import
  transformed config plus manifest; `neem dev` should build/watch the same
  format and globally restart when config changes.
- The transformed config artifact has fixed id `entry` and currently writes
  ESM `.js` output under `outDir/config/entry`.
- App and plugin entry artifacts have fixed id `entry`. App/plugin-declared
  artifacts inherit app/plugin build config; artifact-level Rolldown options
  override/merge with inherited config.
- All generated ESM artifact files should use `.js`, not `.mjs`.
- Plugin entries are authoritative for plugin-declared artifacts. Artifact entry
  URLs such as `new URL('./worker.ts', import.meta.url)` resolve against source
  plugin files during build.
- Build manifest is internal and written as `neem.manifest.json` with relative
  paths.
- Build cleanup is scoped to Neem-owned paths under `outDir`: `config/`,
  `apps/`, `plugins/`, and `neem.manifest.json`. Unrelated files must survive.
- Production `start` imports transformed config only to read app thread options;
  it must not call config app/plugin/build lazy thunks.
- Production `start` builds an absolute artifact registry from manifest paths
  and passes it to app runtime contexts.
- Production app runtimes run in Node worker threads, one worker per configured
  app thread.
- Runtime mode is host-provided through worker data: `neem start` uses
  `production`; future `neem dev` uses `development`.
- App worker bootstrap is an internal package-built Neem artifact
  (`dist/internal/app-worker-entry.js`), not an eval string and not a user
  manifest artifact.
- First `start` failure policy is fail-fast: any bootstrap/start failure rejects
  startup and stops already-started workers; any post-start worker failure stops
  the host.
- Plugins are build-visible and present in the artifact registry, but plugin
  lifecycle and plugin worker spawning are deferred.

## Artifact + Runtime Unit Model

Definitions:

- Source entry: user-authored path from config or plugin/app declaration.
- Artifact: compiled executable/importable output produced by Rolldown.
- Config artifact: transformed single-file config output used by future
  start/dev flows; it is not bundled with lazy app/plugin/build imports.
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
- The transformed config preserves those lazy imports. Runtime code should not
  call app/plugin/build thunks from transformed config to discover artifacts;
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
- `build`: compile production app/plugin entry artifacts and
  plugin-declared artifacts.
- `watch`: dev rebuild loop for discovered app/plugin artifacts.
- `rolldown`: reserved for lower-level build control if `build` becomes too
  coarse.
- `rolldown/utils.transform`: transform config source as a single ESM file
  without bundling lazy imports.
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
2. Transform/watch the config module as a single file into the same format used
   by production.
3. Load transformed config as cheap data.
4. Match loaded config objects with discovered entry metadata.
5. Build/load selected app and plugin entries through the baseline Rolldown
   pipeline.
6. Collect app runtime units and plugin artifact declarations.
7. Start Rolldown watchers for app artifacts and plugin artifacts.
8. Start runtime units from current compiled artifacts.
9. On config rebuild, globally restart the host.
10. On app/plugin artifact rebuild, hard-restart the affected unit.
11. On rebuild error, keep existing running unit alive.

Expected production build flow:

1. Discover static app/plugin entry imports from config source.
2. Load source config and source app/plugin entries with native import.
3. Transform config into `outDir/config/entry` without bundling lazy imports.
4. Build app entry artifacts with fixed id `entry`.
5. Build plugin entry artifacts with fixed id `entry`.
6. Collect plugin artifact declarations from source plugin entries so
   source-relative artifact URLs resolve correctly.
7. Build all plugin-declared artifacts.
8. Write internal `neem.manifest.json` with relative artifact/config paths,
   artifact ids, kinds, owners, app entries, plugin entries, and plugin
   artifacts.
9. `neem start` imports transformed config and manifest and does not compile.

Expected production start flow:

1. Read `outDir/neem.manifest.json`.
2. Import transformed config from manifest `config.file`.
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
draft has started with `neem build` and production-only `neem start`; `dev`
remains planned, not wired.

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
- Transform config during build without bundling lazy imports.
- Emit ESM artifacts as `.js`.
- Clean only Neem-owned output paths.
- Write internal `neem.manifest.json` using relative paths.
- Add tests for build output, manifest path portability, Neem-owned cleanup,
  CLI build, `.js` output, non-bundled config transform, and plugin
  source-relative artifact declarations.
- Wire `neem start --outDir <path>` against built output only.
- Start generic Neem apps in worker threads from built app entry artifacts.
- Use the typed package-built app worker entry for worker bootstrap; source-mode
  tests must build `@nmtjs/neem` first so `dist/internal/app-worker-entry.js`
  exists.
- Track app upstreams for future proxy integration but do not wire proxy yet.
- Keep plugin lifecycle unwired while preserving plugin artifacts in the runtime
  registry.
- Keep `tests/neem` as a consumer-style package that imports `@nmtjs/neem`
  through package exports and captures what feels good or breaks in user-facing
  config/app/plugin code.

Do not include in first draft:

- Vite integration
- in-process HMR/reload
- `neem dev` watch/restart runtime
- full jobs plugin
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
