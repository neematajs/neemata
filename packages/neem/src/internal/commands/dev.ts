import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { debounce } from 'perfect-debounce'

import {
  cleanNeemOutDir,
  createConfigRolldownOptions,
  loadBuildConfig,
  toManifestArtifact,
  toManifestPath,
  writeManifest,
} from './build.ts'

import type {
  NeemConfigDiscovery,
  NeemDiscoveredApp,
  NeemDiscoveredPlugin,
} from '#build/discovery.ts'
import { discoverConfigEntriesSync } from '#build/discovery.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '#build/manifest.ts'
import { NEEM_MANIFEST_SCHEMA_VERSION } from '#build/manifest.ts'
import type { NeemArtifactWatcher } from '#build/rolldown.ts'
import { watchArtifact } from '#build/rolldown.ts'
import type { NeemArtifact, NeemResolvedArtifact } from '#public/artifact.ts'
import type {
  NeemBuildConfig,
  NeemBuildConfigInput,
  NeemConfig,
} from '#public/config.ts'
import type { NeemPlugin } from '#public/plugin.ts'
import type {
  NeemApplicationServer,
  NeemApplicationServerSnapshot,
} from '#runtime/application-server.ts'
import { NeemApplicationServer as RuntimeApplicationServer } from '#runtime/application-server.ts'
import {
  createNeemDefaultLogger,
  resolveNeemConfigLogger,
} from '#runtime/logger.ts'
import { createRuntimeSnapshot } from '#runtime/snapshot.ts'
import { importDefault } from '#runtime/utils.ts'

export type NeemDevOptions = {
  config?: string
  outDir?: string
  cwd?: string
  signal?: AbortSignal
}

export type NeemDevHost = {
  configFile: string
  outDir: string
  ready: Promise<void>
  closed: Promise<void>
  getLifecycle: () => NeemDevLifecycleSnapshot
  getRuntime: () => NeemApplicationServer | undefined
  stop: () => Promise<void>
}

type AppWatcherState = { watcher: NeemArtifactWatcher; entry: string }
type PluginWatcherState = {
  watcher: NeemArtifactWatcher
  entry: string
  name: string
}
type PluginArtifactWatcherState = {
  watcher: NeemArtifactWatcher
  entry: string
}
type PluginArtifactState = {
  name: string
  artifacts: Map<string, NeemResolvedArtifact>
}
type NeemDevReloadRequest =
  | { type: 'full' }
  | { type: 'apps'; appNames: string[] }
type NeemDevLifecycleSnapshot =
  | NeemApplicationServerSnapshot
  | {
      state:
        | 'idle'
        | 'starting'
        | 'reloading'
        | 'failed'
        | 'stopping'
        | 'stopped'
      lastError?: Error
    }

const NEEM_DEV_RELOAD_DEBOUNCE_MS = 100

export async function devNeem(
  options: NeemDevOptions = {},
): Promise<NeemDevHost> {
  const cwd = options.cwd ?? process.cwd()
  const session = new NeemDevSession({
    configFile: resolve(cwd, options.config ?? 'neem.config.ts'),
    outDir: resolve(cwd, options.outDir ?? '.neem'),
    signal: options.signal,
  })
  await session.start()
  return session
}

class NeemDevSession implements NeemDevHost {
  readonly configFile: string
  readonly outDir: string
  readonly ready: Promise<void>
  readonly closed: Promise<void>

  private discovery: NeemConfigDiscovery | undefined
  private configArtifact: NeemResolvedArtifact | undefined
  private config: NeemConfig | undefined
  private logger = createNeemDefaultLogger('development')
  private configWatcher: NeemArtifactWatcher | undefined
  private runtime: NeemApplicationServer | undefined
  private appWatchers = new Map<string, AppWatcherState>()
  private appArtifacts = new Map<string, NeemResolvedArtifact>()
  private pluginWatchers = new Map<number, PluginWatcherState>()
  private pluginEntryArtifacts = new Map<number, NeemResolvedArtifact>()
  private pluginArtifactWatchers = new Map<
    number,
    Map<string, PluginArtifactWatcherState>
  >()
  private pluginArtifacts = new Map<number, PluginArtifactState>()
  private operation = Promise.resolve()
  private runtimeOperation = Promise.resolve()
  private lifecycle: NeemDevLifecycleSnapshot = { state: 'idle' }
  private stopped = false
  private pendingFullReload = false
  private pendingAppReloads = new Set<string>()
  private reloadFlushQueued = false
  private scheduleRuntimeReloadFlush = debounce(
    () => this.queueRuntimeReloadFlush(),
    NEEM_DEV_RELOAD_DEBOUNCE_MS,
  )
  private readySettled = false
  private closedSettled = false
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private closedResolve!: () => void
  private initializingApps = new Set<string>()
  private initializingPlugins = new Set<number>()
  private initializingPluginArtifacts = new Set<string>()

  constructor(options: {
    configFile: string
    outDir: string
    signal?: AbortSignal
  }) {
    this.configFile = options.configFile
    this.outDir = options.outDir
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.ready.catch(() => {})
    this.closed = new Promise<void>((resolve) => {
      this.closedResolve = resolve
    })

    if (options.signal?.aborted) {
      this.stopped = true
    } else {
      options.signal?.addEventListener(
        'abort',
        () => {
          void this.stop()
        },
        { once: true },
      )
    }
  }

  async start(): Promise<void> {
    if (this.stopped) {
      this.rejectReady(new Error('Neem dev stopped before startup'))
      this.lifecycle = { state: 'stopped' }
      this.settleClosed()
      return
    }

    this.lifecycle = { state: 'starting' }
    this.logger.info(
      { configFile: this.configFile, outDir: this.outDir },
      'Starting Neem dev session',
    )
    await cleanNeemOutDir(this.outDir)
    await this.startConfigWatcher()
  }

  getLifecycle() {
    return this.runtime?.getSnapshot() ?? this.lifecycle
  }

  getRuntime() {
    return this.runtime
  }

  async stop(): Promise<void> {
    if (this.closedSettled) return
    this.stopped = true
    this.lifecycle = { state: 'stopping' }
    this.logger.info('Stopping Neem dev session')

    this.scheduleRuntimeReloadFlush.cancel()
    await this.stopAppWatchers()
    await this.stopPluginWatchers()
    await this.configWatcher?.close()
    this.configWatcher = undefined
    await this.operation.catch(() => {})
    await this.runtimeOperation.catch(() => {})
    await this.stopRuntime()
    this.rejectReady(new Error('Neem dev stopped before ready'))
    this.lifecycle = { state: 'stopped' }
    this.logger.info('Neem dev session stopped')
    this.settleClosed()
  }

  private async stopAppWatchers(): Promise<void> {
    const watchers = [...this.appWatchers.values()]
    this.logger.debug({ count: watchers.length }, 'Closing Neem app watchers')
    this.appWatchers.clear()
    this.appArtifacts.clear()
    await Promise.all(watchers.map((state) => state.watcher.close()))
  }

  private async stopPluginWatchers(): Promise<void> {
    const pluginWatchers = [...this.pluginWatchers.values()]
    const artifactWatchers = [...this.pluginArtifactWatchers.values()].flatMap(
      (watchers) => [...watchers.values()],
    )
    this.logger.debug(
      { plugins: pluginWatchers.length, artifacts: artifactWatchers.length },
      'Closing Neem plugin watchers',
    )

    this.pluginWatchers.clear()
    this.pluginEntryArtifacts.clear()
    this.pluginArtifactWatchers.clear()
    this.pluginArtifacts.clear()

    await Promise.all([
      ...pluginWatchers.map((state) => state.watcher.close()),
      ...artifactWatchers.map((state) => state.watcher.close()),
    ])
  }

  private async startConfigWatcher(): Promise<void> {
    this.discovery = discoverConfigEntriesSync(this.configFile)
    this.logger.trace(
      { configFile: this.configFile },
      'Starting Neem config watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: { id: 'entry', kind: 'module', entry: this.configFile },
        owner: { type: 'config' },
        rolldown: createConfigRolldownOptions(() =>
          discoverConfigEntriesSync(this.configFile),
        ),
        outDir: this.outDir,
      },
      {
        onRebuild: (artifact) => {
          return this.enqueue(() => this.applyConfigArtifact(artifact))
        },
        onError: (error) => {
          this.recordError(error)
        },
      },
    )
    watcher.ready.catch((error) => {
      this.recordError(error)
    })
    this.configWatcher = watcher
  }

  private async applyConfigArtifact(
    artifact: NeemResolvedArtifact,
  ): Promise<void> {
    if (this.stopped) return
    this.beginRuntimeChange()

    this.discovery = discoverConfigEntriesSync(this.configFile)
    this.configArtifact = artifact
    this.config = await importDefault<NeemConfig>(artifact.file)
    this.logger = await resolveNeemConfigLogger(this.config, {
      mode: 'development',
    })
    this.logger.trace({ file: artifact.file }, 'Neem config loaded')

    await this.reconcileAppWatchers()
    await this.reconcilePluginWatchers()
    this.scheduleFullRuntimeReload()
  }

  private async reconcileAppWatchers(): Promise<void> {
    if (!this.config || !this.discovery) return

    const appNames = new Set(Object.keys(this.config.apps))

    await Promise.all(
      [...this.appWatchers.entries()]
        .filter(([name]) => !appNames.has(name))
        .map(async ([name, state]) => {
          this.logger.debug({ appName: name }, 'Removing Neem app watcher')
          await state.watcher.close()
          this.appWatchers.delete(name)
          this.appArtifacts.delete(name)
        }),
    )

    for (const [name, appConfig] of Object.entries(this.config.apps)) {
      const discovered = this.discovery.apps[name]
      if (!discovered) {
        throw new Error(`Failed to discover app entry for [${name}]`)
      }

      const current = this.appWatchers.get(name)
      if (current?.entry === discovered.entry.resolved) continue

      if (current) {
        this.logger.debug({ appName: name }, 'Replacing Neem app watcher')
        await current.watcher.close()
        this.appWatchers.delete(name)
        this.appArtifacts.delete(name)
      }

      const artifact = await this.startAppWatcher(
        name,
        appConfig.build,
        discovered,
      )
      this.appArtifacts.set(name, artifact)
    }
  }

  private async reconcilePluginWatchers(): Promise<void> {
    if (!this.config || !this.discovery) return

    const pluginIndexes = new Set(
      (this.config.plugins ?? []).map((_plugin, index) => index),
    )

    await Promise.all(
      [...this.pluginWatchers.entries()]
        .filter(([index]) => !pluginIndexes.has(index))
        .map(([index]) => this.removePlugin(index)),
    )

    for (const [index, pluginConfig] of (this.config.plugins ?? []).entries()) {
      const discovered = this.discovery.plugins[index]
      if (!discovered) {
        throw new Error(`Failed to discover plugin entry for index [${index}]`)
      }

      const current = this.pluginWatchers.get(index)
      if (current?.entry !== discovered.entry.resolved) {
        if (current) await this.removePlugin(index)
        const artifact = await this.startPluginWatcher(
          index,
          pluginConfig.build,
          discovered,
        )
        this.pluginEntryArtifacts.set(index, artifact)
      }

      const entryArtifact = this.pluginEntryArtifacts.get(index)
      if (!entryArtifact) {
        throw new Error(`Compiled artifact for plugin [${index}] is missing`)
      }
      const plugin = await importDefault<NeemPlugin<unknown>>(
        entryArtifact.file,
      )
      const ownedEntryArtifact = withPluginOwner(
        index,
        plugin.name,
        entryArtifact,
      )
      this.pluginEntryArtifacts.set(index, ownedEntryArtifact)
      const next = this.pluginWatchers.get(index)
      if (next && next.name !== plugin.name) {
        this.pluginWatchers.set(index, { ...next, name: plugin.name })
      }

      await this.reconcilePluginArtifactWatchers(
        index,
        plugin,
        pluginConfig.options,
        pluginConfig.build,
        discovered,
      )
    }
  }

  private async removePlugin(index: number): Promise<void> {
    const entry = this.pluginWatchers.get(index)
    this.logger.debug(
      { instanceId: index, plugin: entry?.name },
      'Removing Neem plugin watcher',
    )
    if (entry) await entry.watcher.close()
    this.pluginWatchers.delete(index)
    this.pluginEntryArtifacts.delete(index)
    this.pluginArtifacts.delete(index)
    const artifactWatchers = this.pluginArtifactWatchers.get(index)
    this.pluginArtifactWatchers.delete(index)
    await Promise.all(
      [...(artifactWatchers?.values() ?? [])].map((state) =>
        state.watcher.close(),
      ),
    )
  }

  private async startPluginWatcher(
    index: number,
    buildConfigInput: NeemBuildConfigInput | undefined,
    discovered: NeemDiscoveredPlugin,
  ): Promise<NeemResolvedArtifact> {
    const rolldown = await loadPluginBuildConfig(buildConfigInput, discovered)
    this.initializingPlugins.add(index)
    const temporaryName = `plugin-${index}`
    this.logger.debug(
      {
        plugin: temporaryName,
        instanceId: index,
        entry: discovered.entry.resolved,
      },
      'Starting Neem plugin watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: {
          id: 'entry',
          kind: 'module',
          entry: discovered.entry.resolved,
        },
        owner: { type: 'plugin', name: temporaryName, instanceId: index },
        rolldown,
        outDir: this.outDir,
      },
      {
        onRebuild: (artifact) => {
          const initial = this.initializingPlugins.has(index)
          return this.enqueue(() =>
            this.applyPluginEntryArtifact(index, artifact, { initial }),
          )
        },
        onError: (error) => {
          this.recordError(error)
        },
      },
    )

    this.pluginWatchers.set(index, {
      watcher,
      entry: discovered.entry.resolved,
      name: temporaryName,
    })

    try {
      return await watcher.ready
    } finally {
      this.initializingPlugins.delete(index)
    }
  }

  private async applyPluginEntryArtifact(
    index: number,
    artifact: NeemResolvedArtifact,
    options: { initial: boolean },
  ): Promise<void> {
    if (this.stopped || !this.config || !this.discovery) return
    const plugin = await importDefault<NeemPlugin<unknown>>(artifact.file)
    const ownedArtifact = withPluginOwner(index, plugin.name, artifact)
    this.pluginEntryArtifacts.set(index, ownedArtifact)
    const current = this.pluginWatchers.get(index)
    if (current)
      this.pluginWatchers.set(index, { ...current, name: plugin.name })
    if (options.initial) return

    const pluginConfig = this.config.plugins?.[index]
    const discovered = this.discovery.plugins[index]
    if (!pluginConfig || !discovered) return

    await this.reconcilePluginArtifactWatchers(
      index,
      plugin,
      pluginConfig.options,
      pluginConfig.build,
      discovered,
    )

    this.scheduleFullRuntimeReload()
  }

  private async reconcilePluginArtifactWatchers(
    index: number,
    plugin: NeemPlugin<unknown>,
    options: unknown,
    buildConfigInput: NeemBuildConfigInput | undefined,
    discovered: NeemDiscoveredPlugin,
  ): Promise<void> {
    const rawDeclared =
      (await plugin.artifacts?.({
        mode: 'development',
        name: plugin.name,
        instanceId: index,
        options,
        logger: this.logger,
      })) ?? []
    const entryArtifact = this.pluginEntryArtifacts.get(index)
    if (!entryArtifact) {
      throw new Error(`Compiled artifact for plugin [${index}] is missing`)
    }
    const declared = rawDeclared.map((artifact) =>
      withSourceRelativePluginArtifact(artifact, discovered, entryArtifact),
    )
    const nextIds = new Set(declared.map((artifact) => artifact.id))
    let watchers = this.pluginArtifactWatchers.get(index)
    if (!watchers) {
      watchers = new Map()
      this.pluginArtifactWatchers.set(index, watchers)
    }
    let artifactState = this.pluginArtifacts.get(index)
    if (!artifactState) {
      artifactState = { name: plugin.name, artifacts: new Map() }
      this.pluginArtifacts.set(index, artifactState)
    }
    artifactState.name = plugin.name

    await Promise.all(
      [...watchers.entries()]
        .filter(([id]) => !nextIds.has(id))
        .map(async ([id, state]) => {
          await state.watcher.close()
          watchers.delete(id)
          artifactState.artifacts.delete(id)
        }),
    )

    const rolldown = await loadPluginBuildConfig(buildConfigInput, discovered)
    for (const artifact of declared) {
      const entry = artifact.entry.toString()
      const current = watchers.get(artifact.id)
      if (current?.entry === entry) continue

      if (current) {
        await current.watcher.close()
        watchers.delete(artifact.id)
        artifactState.artifacts.delete(artifact.id)
      }

      const built = await this.startPluginArtifactWatcher(
        index,
        plugin.name,
        artifact,
        rolldown,
        discovered,
      )
      artifactState.artifacts.set(artifact.id, built)
    }
  }

  private async startPluginArtifactWatcher(
    index: number,
    pluginName: string,
    artifact: NeemArtifact,
    rolldown: NeemBuildConfig | undefined,
    discovered: NeemDiscoveredPlugin,
  ): Promise<NeemResolvedArtifact> {
    const key = `${index}:${artifact.id}`
    this.initializingPluginArtifacts.add(key)
    const watcher = await watchArtifact(
      {
        artifact,
        owner: { type: 'plugin', name: pluginName, instanceId: index },
        rolldown,
        cwd: dirname(discovered.entry.resolved),
        outDir: this.outDir,
      },
      {
        onRebuild: (built) => {
          const initial = this.initializingPluginArtifacts.has(key)
          return this.enqueue(() =>
            this.applyPluginArtifact(index, pluginName, built, { initial }),
          )
        },
        onError: (error) => {
          this.recordError(error)
        },
      },
    )

    let watchers = this.pluginArtifactWatchers.get(index)
    if (!watchers) {
      watchers = new Map()
      this.pluginArtifactWatchers.set(index, watchers)
    }
    watchers.set(artifact.id, { watcher, entry: artifact.entry.toString() })

    try {
      return await watcher.ready
    } finally {
      this.initializingPluginArtifacts.delete(key)
    }
  }

  private async applyPluginArtifact(
    index: number,
    pluginName: string,
    artifact: NeemResolvedArtifact,
    options: { initial: boolean },
  ): Promise<void> {
    if (this.stopped) return
    let artifactState = this.pluginArtifacts.get(index)
    if (!artifactState) {
      artifactState = { name: pluginName, artifacts: new Map() }
      this.pluginArtifacts.set(index, artifactState)
    }
    artifactState.name = pluginName
    artifactState.artifacts.set(artifact.id, artifact)
    if (options.initial) return

    this.scheduleFullRuntimeReload()
  }

  private async startAppWatcher(
    name: string,
    buildConfigInput: NeemBuildConfigInput | undefined,
    discovered: NeemDiscoveredApp,
  ): Promise<NeemResolvedArtifact> {
    const rolldown = await loadAppBuildConfig(buildConfigInput, discovered)
    this.initializingApps.add(name)
    this.logger.trace(
      { appName: name, entry: discovered.entry.resolved },
      'Starting Neem app watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: {
          id: 'entry',
          kind: 'module',
          entry: discovered.entry.resolved,
        },
        owner: { type: 'app', name },
        rolldown,
        outDir: this.outDir,
      },
      {
        onRebuild: (artifact) => {
          const initial = this.initializingApps.has(name)
          return this.enqueue(() =>
            this.applyAppArtifact(name, artifact, { initial }),
          )
        },
        onError: (error) => {
          this.recordError(error)
        },
      },
    )

    this.appWatchers.set(name, { watcher, entry: discovered.entry.resolved })

    try {
      return await watcher.ready
    } finally {
      this.initializingApps.delete(name)
    }
  }

  private async applyAppArtifact(
    name: string,
    artifact: NeemResolvedArtifact,
    options: { initial: boolean },
  ): Promise<void> {
    if (this.stopped) return
    this.appArtifacts.set(name, artifact)
    if (options.initial) return

    this.scheduleAppRuntimeReload(name)
  }

  private async writeCurrentManifest(): Promise<NeemBuildManifest> {
    if (!this.configArtifact || !this.config) {
      throw new Error('Cannot write Neem dev manifest before config is loaded')
    }

    const manifest: NeemBuildManifest = {
      schemaVersion: NEEM_MANIFEST_SCHEMA_VERSION,
      config: { file: toManifestPath(this.outDir, this.configArtifact.file) },
      apps: {},
      plugins: [],
    }

    for (const name of Object.keys(this.config.apps)) {
      const artifact = this.appArtifacts.get(name)
      if (!artifact) {
        throw new Error(`Compiled artifact for app [${name}] is missing`)
      }
      manifest.apps[name] = {
        name,
        entry: toManifestArtifact(this.outDir, artifact),
      }
    }

    for (const [index, pluginConfig] of (this.config.plugins ?? []).entries()) {
      const state = this.pluginArtifacts.get(index)
      const entry = this.pluginEntryArtifacts.get(index)
      if (!state || !entry) {
        throw new Error(`Compiled artifact for plugin [${index}] is missing`)
      }

      manifest.plugins.push({
        index,
        name: state.name,
        entry: toManifestArtifact(this.outDir, entry),
        artifacts: toManifestPluginArtifacts(this.outDir, state.artifacts),
      })
    }

    await writeManifest(this.outDir, manifest)
    return manifest
  }

  private async restartRuntime(manifest: NeemBuildManifest): Promise<void> {
    if (this.stopped) return

    if (!this.config) {
      throw new Error('Cannot start Neem dev runtime before config is loaded')
    }

    const snapshot = createRuntimeSnapshot({
      mode: 'development',
      outDir: this.outDir,
      manifest,
      config: this.config,
      logger: this.logger,
    })

    try {
      const reloading = !!this.runtime
      if (this.runtime) {
        this.logger.info('Reloading Neem dev runtime...')
        await this.runtime.reload(snapshot)
      } else {
        this.logger.info('Starting Neem dev runtime...')
        this.runtime = new RuntimeApplicationServer({
          snapshot,
          failOnWorkerError: false,
        })
        await this.runtime.start()
      }
      this.lifecycle = this.runtime.getSnapshot()
      this.logger.info(
        reloading ? 'Neem dev runtime reloaded' : 'Neem dev runtime ready',
      )
      this.resolveReady()
    } catch (error) {
      this.runtime = undefined
      this.recordError(error)
    }
  }

  private async reloadAppRuntime(
    appName: string,
    manifest: NeemBuildManifest,
  ): Promise<void> {
    if (this.stopped) return

    const snapshot = this.createRuntimeSnapshot(manifest)

    try {
      if (!this.runtime) {
        await this.restartRuntime(manifest)
        return
      }

      this.logger.info({ appName }, 'Reloading Neem app...')
      await this.runtime.reloadApp(appName, snapshot)
      this.lifecycle = this.runtime.getSnapshot()
      this.logger.info({ appName }, 'Neem app reloaded')
      this.resolveReady()
    } catch (error) {
      this.recordError(error)
    }
  }

  private scheduleFullRuntimeReload(): void {
    if (this.stopped) return
    this.pendingFullReload = true
    this.pendingAppReloads.clear()
    this.scheduleRuntimeReload()
  }

  private scheduleAppRuntimeReload(appName: string): void {
    if (this.stopped) return
    if (!this.pendingFullReload) {
      this.pendingAppReloads.add(appName)
    }
    this.scheduleRuntimeReload()
  }

  private scheduleRuntimeReload(): void {
    this.beginRuntimeChange()
    void this.scheduleRuntimeReloadFlush()
  }

  private queueRuntimeReloadFlush(): void {
    if (this.stopped || this.reloadFlushQueued) return
    this.reloadFlushQueued = true
    this.runtimeOperation = this.runtimeOperation
      .then(
        () => this.flushRuntimeReload(),
        () => this.flushRuntimeReload(),
      )
      .catch((error) => {
        this.recordError(error)
      })
  }

  private async flushRuntimeReload(): Promise<void> {
    this.reloadFlushQueued = false
    if (this.stopped) return

    const request = this.takePendingRuntimeReload()
    if (!request) return

    try {
      const manifest = await this.writeCurrentManifest()
      if (request.type === 'full') {
        await this.restartRuntime(manifest)
      } else {
        for (const appName of request.appNames) {
          await this.reloadAppRuntime(appName, manifest)
        }
      }
    } finally {
      if (!this.stopped && this.hasPendingRuntimeReload()) {
        this.scheduleRuntimeReload()
      }
    }
  }

  private takePendingRuntimeReload(): NeemDevReloadRequest | undefined {
    if (this.pendingFullReload) {
      this.pendingFullReload = false
      this.pendingAppReloads.clear()
      return { type: 'full' }
    }

    if (this.pendingAppReloads.size === 0) return undefined
    const appNames = [...this.pendingAppReloads]
    this.pendingAppReloads.clear()
    return { type: 'apps', appNames }
  }

  private hasPendingRuntimeReload(): boolean {
    return this.pendingFullReload || this.pendingAppReloads.size > 0
  }

  private createRuntimeSnapshot(manifest: NeemBuildManifest) {
    if (!this.config) {
      throw new Error('Cannot create Neem runtime snapshot before config loads')
    }

    return createRuntimeSnapshot({
      mode: 'development',
      outDir: this.outDir,
      manifest,
      config: this.config,
      logger: this.logger,
    })
  }

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined
    if (!runtime) return

    this.logger.debug('Stopping Neem dev runtime')
    await runtime.stop()
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.operation = this.operation.then(task, task)
    return this.operation.catch((error) => {
      this.recordError(error)
    })
  }

  private beginRuntimeChange(): void {
    if (this.readySettled) {
      this.lifecycle = { state: 'reloading' }
    }
  }

  private recordError(error: unknown) {
    const normalized =
      error instanceof Error
        ? error
        : new Error(String(error ?? 'Unknown error'))
    this.lifecycle = { state: 'failed', lastError: normalized }
    this.logger.error(
      new Error('Neem dev session failed', { cause: normalized }),
    )
    if (!this.readySettled) {
      this.readyReject(normalized)
      this.readySettled = true
    }
  }

  private resolveReady() {
    if (this.readySettled) return
    this.readySettled = true
    this.readyResolve()
  }

  private rejectReady(error: Error) {
    if (this.readySettled) return
    this.readySettled = true
    this.readyReject(error)
  }

  private settleClosed() {
    if (this.closedSettled) return
    this.closedSettled = true
    this.closedResolve()
  }
}

async function loadAppBuildConfig(
  input: NeemBuildConfigInput | undefined,
  discovered: NeemDiscoveredApp,
): Promise<NeemBuildConfig | undefined> {
  if (discovered.build) {
    return importDefault<NeemBuildConfig>(discovered.build.resolved)
  }

  if (typeof input === 'function') {
    return undefined
  }

  return loadBuildConfig(input)
}

async function loadPluginBuildConfig(
  input: NeemBuildConfigInput | undefined,
  discovered: NeemDiscoveredPlugin,
): Promise<NeemBuildConfig | undefined> {
  if (discovered.build) {
    return importDefault<NeemBuildConfig>(discovered.build.resolved)
  }

  if (typeof input === 'function') {
    return undefined
  }

  return loadBuildConfig(input)
}

function withPluginOwner(
  instanceId: number,
  name: string,
  artifact: NeemResolvedArtifact,
): NeemResolvedArtifact {
  return { ...artifact, owner: { type: 'plugin', name, instanceId } }
}

function withSourceRelativePluginArtifact(
  artifact: NeemArtifact,
  discovered: NeemDiscoveredPlugin,
  entryArtifact: NeemResolvedArtifact,
): NeemArtifact {
  const entry = resolvePluginArtifactEntry(
    artifact.entry,
    dirname(discovered.entry.resolved),
    entryArtifact.outDir,
  )
  return entry === artifact.entry ? artifact : { ...artifact, entry }
}

function resolvePluginArtifactEntry(
  entry: NeemArtifact['entry'],
  sourceDir: string,
  builtEntryDir: string,
): NeemArtifact['entry'] {
  const file = entry instanceof URL ? fileURLToPath(entry) : entry
  const relativeToBuilt = relative(builtEntryDir, file)
  if (relativeToBuilt.startsWith('..')) return entry
  if (relativeToBuilt === '') return entry
  return resolve(sourceDir, relativeToBuilt)
}

function toManifestPluginArtifacts(
  outDir: string,
  artifacts: Map<string, NeemResolvedArtifact>,
): NeemBuildManifestArtifact[] {
  return [...artifacts.values()].map((artifact) =>
    toManifestArtifact(outDir, artifact),
  )
}
