# Neem Architecture

This doc names components as they appear in `packages/neem`.

## Dev

`neem dev` builds watched runtime artifacts into `.neem`, writes a
`NeemBuildManifest`, then starts the same runtime server used by production.
The CLI parent owns config-file watching and restarts the dev child process on
config changes. Inside one child process, `devNeem` imports config once; runtime
and plugin entry source rebuilds reload the server.

```mermaid
flowchart TB
  cli["neem dev<br/>packages/neem/src/cli.ts"]
  devNeem["devNeem(options)<br/>internal/commands/dev.ts"]
  session["NeemDevSession<br/>internal/commands/dev.ts"]

  configFile["neem.config.ts"]
  normalize["normalizeNeemConfig(config)<br/>public/config.ts"]
  pluginPlans["resolvePluginBuildPlans(configFile, config)<br/>internal/build/plugin-plan.ts"]
  pluginRolldown["mergePluginRolldownOptions(pluginPlans)"]
  runtimePlans["resolveRuntimeBuildPlans(..., { rolldown: pluginRolldown })"]
  logger["resolveNeemConfigLogger(...)"]

  runtimeWatcher["watchArtifact({ id: 'entry', kind: 'worker' })"]
  hostWatcher["watchArtifact({ id: 'host', kind: 'module' })"]
  pluginWatcher["watchArtifact({ id: 'plugin', kind: 'module' })"]
  runtimeArtifacts["runtimeArtifacts<br/>Map&lt;runtimeName, NeemResolvedArtifact&gt;"]
  hostArtifacts["runtimeHostArtifacts<br/>Map&lt;runtimeName, NeemResolvedArtifact&gt;"]
  pluginArtifacts["pluginArtifacts<br/>Map&lt;pluginKey, NeemResolvedArtifact&gt;"]
  pluginHooks["registerManifestPluginHooks(...)<br/>internal/runtime/plugin-hooks.ts"]
  manifest["writeCurrentManifest()<br/>.neem/neem.manifest.json"]
  snapshot["createRuntimeSnapshot({ mode: 'development' })"]
  server["NeemRuntimeServer<br/>internal/runtime/server.ts"]

  cli --> devNeem --> session
  cli -. "config change -> restart child process" .-> devNeem
  session -->|"applyConfig()"| configFile
  configFile -->|"importFreshDefault()"| normalize
  normalize --> logger
  normalize --> pluginPlans --> pluginRolldown --> runtimePlans
  runtimePlans --> runtimeWatcher
  runtimePlans --> hostWatcher
  pluginPlans --> pluginWatcher
  runtimeWatcher -->|"onRebuild -> applyRuntimeArtifact()"| runtimeArtifacts
  hostWatcher -->|"onRebuild -> applyRuntimeHostArtifact()"| hostArtifacts
  pluginWatcher -->|"onRebuild -> applyPluginArtifact()"| pluginArtifacts
  runtimeArtifacts --> manifest
  hostArtifacts --> manifest
  pluginArtifacts --> manifest
  manifest --> snapshot
  manifest -->|"reloadPluginHooks()"| pluginHooks
  pluginHooks --> server
  snapshot -->|"restartRuntime()"| server
  server -->|"start() / reload() / reloadRuntime()"| runtimeManager["NeemRuntimeManager"]

  runtimeWatcher -. "scheduleScopedRuntimeReload(runtimeName)" .-> manifest
  hostWatcher -. "scheduleScopedRuntimeReload(runtimeName)" .-> manifest
  pluginWatcher -. "scheduleFullRuntimeReload()" .-> manifest
```

## Prod Build

`neem build` writes `dist/runtime/start.js`, `dist/runtime/worker-entry.js`,
runtime `entry` artifacts, optional runtime `host` artifacts, optional plugin
entry artifacts, and `dist/neem.manifest.json`. Plugin build Rolldown options
are merged into every runtime worker build before runtime-local Rolldown.

```mermaid
flowchart TB
  cli["neem build<br/>packages/neem/src/cli.ts"]
  buildNeem["buildNeem(options)<br/>internal/commands/build.ts"]
  configFile["neem.config.ts"]
  config["normalizeNeemConfig(config)<br/>public/config.ts"]
  pluginPlans["resolvePluginBuildPlans(configFile, config)<br/>internal/build/plugin-plan.ts"]
  pluginRolldown["mergePluginRolldownOptions(pluginPlans)"]
  runtimePlans["resolveRuntimeBuildPlans(..., { rolldown: pluginRolldown })"]

  runtimeStart["buildRuntimeArtifacts().entry<br/>internal/runtime/standalone-entry.ts -> dist/runtime/start.js"]
  runtimeWorker["buildRuntimeArtifacts().worker<br/>internal/runtime/worker-entry.ts -> dist/runtime/worker-entry.js"]
  runtimeEntry["buildArtifact({ id: 'entry', kind: 'worker' })<br/>runtime plan worker entry"]
  runtimeHost["buildArtifact({ id: 'host', kind: 'module' })<br/>runtime plan host entry"]
  pluginEntry["buildArtifact({ id: 'plugin', kind: 'module' })<br/>config/plugins/&lt;ordinal-name&gt;"]
  manifestConfig["createManifestConfig(config, configFile, outDir)"]
  manifest["writeManifest(outDir, manifest)<br/>dist/neem.manifest.json"]
  standalone["writeStandaloneStartEntries()<br/>dist/start.js + dist/runtimes/*/start.js"]

  cli --> buildNeem
  buildNeem --> configFile --> config
  config --> pluginPlans --> pluginRolldown --> runtimePlans
  buildNeem --> runtimeStart
  buildNeem --> runtimeWorker
  runtimePlans --> runtimeEntry
  runtimePlans --> runtimeHost
  pluginPlans --> pluginEntry
  config --> manifestConfig
  runtimeStart --> manifest
  runtimeWorker --> manifest
  runtimeEntry --> manifest
  runtimeHost --> manifest
  pluginEntry --> manifest
  manifestConfig --> manifest
  manifest --> standalone
```

## Prod Start

`neem start` and generated `dist/start.js` both go through `startNeem`.
`startNeem` loads built metadata, creates a `NeemRuntimeSnapshot`, registers
built plugin hooks from manifest order, then starts `NeemRuntimeServer`.
Production never imports original `neem.config.ts`.

```mermaid
flowchart TB
  startCli["neem start<br/>packages/neem/src/cli.ts"]
  distStart["dist/start.js<br/>startStandalone()"]
  startNeem["startNeem(options)<br/>internal/commands/start.ts"]

  loader["loadBuiltRuntimeSnapshot(...)<br/>internal/runtime/snapshot-loader.ts"]
  manifest["dist/neem.manifest.json"]
  manifestLogger["resolveManifestLogger(manifest, outDir, mode)"]
  manifestConfig["createConfigFromManifest(manifest, logger)"]
  snapshot["createRuntimeSnapshot({ mode: 'production' })"]
  hooks["createNeemHostHooks() or options.hooks"]
  server["NeemRuntimeServer<br/>failOnWorkerError: true by default"]
  pluginHooks["registerManifestPluginHooks(...)<br/>import built plugin entry files"]
  host["NeemStartedHost"]

  startCli --> startNeem
  distStart --> startNeem
  startNeem --> loader
  loader --> manifest
  manifest --> manifestLogger
  manifest --> manifestConfig
  manifestLogger --> snapshot
  manifestConfig --> snapshot
  startNeem --> hooks
  snapshot --> server
  hooks --> server
  manifest --> pluginHooks
  server -->|"ctx.getHealth()"| pluginHooks
  pluginHooks --> hooks
  startNeem --> host
  server -->|"start()"| runtimeServerStart["syncHealthProbe() + startRuntime(snapshot)"]
```

## Plugins

Neem plugins are host/build extensions, not runtimes. `neem.config.ts` can
declare ordered `plugins`. Each plugin may provide build Rolldown options,
a host-side `entry`, both, or neither. Duplicate plugin names are allowed;
`name` is diagnostic, while ordinal keys like `000-metrics` make output paths
stable.

```mermaid
flowchart TB
  configPlugin["definePlugin({ name, entry, build, options })"]
  pluginPlan["NeemPluginBuildPlan<br/>key/index/name/entry/rolldown/options"]
  buildRolldown["plugin.build.rolldown"]
  pluginEntry["plugin.entry<br/>built host module"]
  manifestPlugin["manifest.plugins[]<br/>{ name, entry.file, options }"]
  hooksFactory["definePluginHooks((ctx) => hooks)<br/>default export"]
  hookable["NeemHostHooks.addHooks(hooks)<br/>stores disposer"]
  server["NeemRuntimeServer"]

  configPlugin --> pluginPlan
  pluginPlan --> buildRolldown
  pluginPlan --> pluginEntry
  buildRolldown -->|"merged into every runtime worker build"| runtimeBuild["runtime worker build"]
  pluginEntry --> manifestPlugin
  manifestPlugin --> hooksFactory
  hooksFactory --> hookable --> server
```

## Runtime Server

Dev and prod converge here. `NeemRuntimeServer` owns server state, runtime
manager, proxy manager, health probe, proxy upstream registry, and host hooks.

```mermaid
flowchart TB
  server["NeemRuntimeServer<br/>internal/runtime/server.ts"]
  hooks["NeemHostHooks<br/>callNeemHostHook(...)"]
  health["NeemHealthProbeServer<br/>internal/runtime/health-probe.ts"]
  upstreamRegistry["NeemProxyUpstreamRegistry"]
  runtimeManager["NeemRuntimeManager<br/>internal/runtime/runtime.ts"]
  proxyManager["NeemProxyManager<br/>internal/runtime/proxy.ts"]
  nativeProxy["@nmtjs/proxy Proxy"]

  server --> hooks
  server -->|"syncHealthProbe()"| health
  server -->|"startRuntime()"| runtimeManager
  server -->|"startRuntime()"| proxyManager
  server --> upstreamRegistry
  runtimeManager -->|"addOwnerUpstreams() / removeOwnerUpstreams()"| upstreamRegistry
  upstreamRegistry -->|"add / remove events"| proxyManager
  proxyManager --> nativeProxy
```

## Runtime Internals

Each configured runtime becomes one `NeemRuntimeHostRuntime`. Host code can
provide a custom `plan()`. Without host plan, Neem creates default
`NeemRuntimeThreadPlan` values from `runtimeConfig.threads`.

```mermaid
flowchart TB
  manager["NeemRuntimeManager"]
  hostRuntime["NeemRuntimeHostRuntime"]
  hostFactory["NeemRuntimeHostFactory<br/>defineRuntimeHost(...)"]
  host["NeemRuntimeHost<br/>plan/start/stop/fail"]
  defaultPlans["createDefaultRuntimeThreadPlans(snapshot, runtimeName)"]
  threads["createRuntimeThreads(...)"]
  pools["createRuntimeThreadPools(...)<br/>NeemRuntimeThreadPool"]
  pool["NeemWorkerPool&lt;NeemRuntimeThread&gt;"]
  thread["NeemRuntimeThread"]
  managed["NeemManagedWorker"]
  workerEntry["worker-entry.ts"]
  workerModule["NeemWorker<br/>defineWorker(...)"]
  runtime["NeemRuntime<br/>worker.createRuntime(...).start()"]
  upstreams["NeemRuntimeUpstream[]"]

  manager --> hostRuntime
  hostRuntime -->|"loadHost()"| hostFactory --> host
  host -->|"plan() optional"| threads
  hostRuntime -->|"no host plan"| defaultPlans --> threads
  threads --> thread
  threads --> pools --> pool
  pool -->|"start()"| thread
  thread --> managed
  managed -->|"new Worker(entry, workerData)"| workerEntry
  workerEntry -->|"importDefault(data.artifact.file)"| workerModule
  workerModule -->|"createRuntime({ mode, name, data, logger, definition, artifact, artifacts, port })"| runtime
  runtime -->|"start()"| upstreams
  upstreams -->|"ready message"| thread
```

## Reload Paths

```mermaid
flowchart LR
  configChange["neem.config.ts changed<br/>(CLI parent)"]
  runtimeChange["runtime entry / emitted artifact changed"]
  hostChange["runtime host changed"]
  pluginChange["plugin entry changed"]
  childRestart["restart dev child process"]
  full["scheduleFullRuntimeReload()"]
  scoped["scheduleScopedRuntimeReload(runtimeName)"]
  manifest["writeCurrentManifest()"]
  pluginHooks["remove old plugin hook disposers<br/>registerManifestPluginHooks()"]
  reload["NeemRuntimeServer.reload(snapshot)"]
  reloadRuntime["NeemRuntimeServer.reloadRuntime(runtimeName, snapshot)"]

  configChange --> childRestart
  runtimeChange --> scoped --> manifest --> reloadRuntime
  hostChange --> scoped --> manifest --> reloadRuntime
  pluginChange --> full --> manifest --> pluginHooks --> reload
```
