import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { debounce } from 'perfect-debounce'

import type {
  NeemArtifact,
  NeemResolvedArtifact,
  NeemRolldownOptions,
} from '../../public/artifact.ts'
import type { NeemConfig, NeemNormalizedConfig } from '../../public/config.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemPluginBuildPlan } from '../build/plugin-plan.ts'
import type { NeemArtifactWatcher } from '../build/rolldown.ts'
import type { NeemHostHooks } from '../runtime/hooks.ts'
import type { NeemPluginHookRegistration } from '../runtime/plugin-hooks.ts'
import type {
  NeemRuntimeServer,
  NeemRuntimeServerHealth,
  NeemRuntimeServerSnapshot,
} from '../runtime/server.ts'
import { normalizeNeemConfig } from '../../public/config.ts'
import { resolveNeemConfigLogger } from '../build/logger.ts'
import { NEEM_MANIFEST_SCHEMA_VERSION } from '../build/manifest.ts'
import {
  normalizeSelectedRuntimeNames,
  resolveRuntimeBuildPlans,
} from '../build/runtime-plan.ts'
import {
  mergePluginRolldownOptions,
  resolvePluginBuildPlans,
} from '../build/plugin-plan.ts'
import { toBuildEntryKey } from '../build/resolve.ts'
import { watchArtifact } from '../build/rolldown.ts'
import { createNeemHostHooks } from '../runtime/hooks.ts'
import { createNeemDefaultLogger } from '../runtime/logger.ts'
import { registerManifestPluginHooks } from '../runtime/plugin-hooks.ts'
import { NeemRuntimeServer as RuntimeServer } from '../runtime/server.ts'
import { createRuntimeSnapshot } from '../runtime/snapshot.ts'
import { importDefault } from '../runtime/utils.ts'
import {
  cleanNeemOutDir,
  createManifestConfig,
  toManifestArtifact,
  writeManifest,
} from './build.ts'

export type NeemDevOptions = {
  config: string
  outDir: string
  cwd?: string
  runtimes?: readonly string[]
  hooks?: NeemHostHooks
  signal?: AbortSignal
}

export type NeemDevHost = {
  configFile: string
  outDir: string
  ready: Promise<void>
  closed: Promise<void>
  getLifecycle: () => NeemDevLifecycleSnapshot
  getHealth: () => NeemDevHealthSnapshot
  getRuntime: () => NeemRuntimeServer | undefined
  stop: () => Promise<void>
}

type RuntimeWatcherState = { watcher: NeemArtifactWatcher }
type NeemDevReloadRequest =
  | { type: 'full' }
  | { type: 'runtimes'; runtimeNames: string[] }
type NeemDevLifecycleSnapshot =
  | NeemRuntimeServerSnapshot
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
type NeemDevHealthSnapshot =
  | NeemRuntimeServerHealth
  | (NeemDevLifecycleSnapshot & { ready: false })

const NEEM_DEV_RELOAD_DEBOUNCE_MS = 100

export async function devNeem(options: NeemDevOptions): Promise<NeemDevHost> {
  const cwd = options.cwd ?? process.cwd()
  const session = new NeemDevSession({
    configFile: resolve(cwd, options.config ?? 'neem.config.ts'),
    outDir: resolve(cwd, options.outDir ?? '.neem'),
    runtimes: options.runtimes,
    hooks: options.hooks,
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

  private config: NeemNormalizedConfig | undefined
  private logger = createNeemDefaultLogger('development')
  private runtime: NeemRuntimeServer | undefined
  private runtimeWatchers = new Map<string, RuntimeWatcherState>()
  private runtimeArtifacts = new Map<string, NeemResolvedArtifact>()
  private runtimeHostWatchers = new Map<string, RuntimeWatcherState>()
  private runtimeHostArtifacts = new Map<string, NeemResolvedArtifact>()
  private pluginPlans: readonly NeemPluginBuildPlan[] = []
  private pluginWatchers = new Map<string, RuntimeWatcherState>()
  private pluginArtifacts = new Map<string, NeemResolvedArtifact>()
  private pluginHookRegistrations: NeemPluginHookRegistration[] = []
  private operation = Promise.resolve()
  private runtimeOperation = Promise.resolve()
  private lifecycle: NeemDevLifecycleSnapshot = { state: 'idle' }
  private stopped = false
  private pendingFullReload = false
  private pendingRuntimeReloads = new Set<string>()
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
  private readonly selectedRuntimes: readonly string[] | undefined
  private readonly hooks: NeemHostHooks
  private initializingRuntimes = new Set<string>()
  private initializingRuntimeHosts = new Set<string>()
  private initializingPlugins = new Set<string>()

  constructor(options: {
    configFile: string
    outDir: string
    runtimes?: readonly string[]
    hooks?: NeemHostHooks
    signal?: AbortSignal
  }) {
    this.configFile = options.configFile
    this.outDir = options.outDir
    this.selectedRuntimes = normalizeSelectedRuntimeNames(options.runtimes)
    this.hooks = options.hooks ?? createNeemHostHooks()
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
    await this.applyConfig()
  }

  getLifecycle() {
    return this.runtime?.getSnapshot() ?? this.lifecycle
  }

  getHealth(): NeemDevHealthSnapshot {
    return this.runtime?.getHealth() ?? { ...this.lifecycle, ready: false }
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
    await this.stopRuntimeWatchers()
    await this.operation.catch(() => {})
    await this.runtimeOperation.catch(() => {})
    await this.stopRuntime()
    this.removePluginHooks()
    this.rejectReady(new Error('Neem dev stopped before ready'))
    this.lifecycle = { state: 'stopped' }
    this.logger.info('Neem dev session stopped')
    this.settleClosed()
  }

  private async stopRuntimeWatchers(): Promise<void> {
    const watchers = [
      ...this.runtimeWatchers.values(),
      ...this.runtimeHostWatchers.values(),
      ...this.pluginWatchers.values(),
    ]
    this.logger.debug(
      { count: watchers.length },
      'Closing Neem runtime watchers',
    )
    this.runtimeWatchers.clear()
    this.runtimeArtifacts.clear()
    this.runtimeHostWatchers.clear()
    this.runtimeHostArtifacts.clear()
    this.pluginWatchers.clear()
    this.pluginArtifacts.clear()
    await Promise.all(watchers.map((state) => state.watcher.close()))
  }

  private async applyConfig(): Promise<void> {
    if (this.stopped) return
    this.beginRuntimeChange()

    this.config = normalizeNeemConfig(
      await importFreshDefault<NeemConfig>(this.configFile),
    )
    this.logger = await resolveNeemConfigLogger(this.config, {
      mode: 'development',
      importer: this.configFile,
    })
    this.pluginPlans = resolvePluginBuildPlans(this.configFile, this.config)
    this.logger.trace({ file: this.configFile }, 'Neem config loaded')

    await this.startRuntimeWatchers()
    await this.startPluginWatchers()
    this.scheduleFullRuntimeReload()
  }

  private async startRuntimeWatchers(): Promise<void> {
    if (!this.config) return

    const runtimePlans = resolveRuntimeBuildPlans(
      this.configFile,
      this.config,
      this.selectedRuntimes,
      { rolldown: mergePluginRolldownOptions(this.pluginPlans) },
    )

    for (const plan of runtimePlans) {
      const artifact = await this.startRuntimeWatcher(
        plan.name,
        plan.worker.rolldown,
        plan.worker.entry,
        plan.worker.artifacts,
      )
      this.runtimeArtifacts.set(plan.name, artifact)

      if (plan.host) {
        const hostArtifact = await this.startRuntimeHostWatcher(
          plan.name,
          plan.host.rolldown,
          plan.host.entry,
        )
        this.runtimeHostArtifacts.set(plan.name, hostArtifact)
      }
    }
  }

  private async startPluginWatchers(): Promise<void> {
    for (const plan of this.pluginPlans) {
      if (!plan.entry) continue

      const artifact = await this.startPluginWatcher(plan)
      this.pluginArtifacts.set(plan.key, artifact)
    }
  }

  private async startPluginWatcher(
    plan: NeemPluginBuildPlan,
  ): Promise<NeemResolvedArtifact> {
    this.initializingPlugins.add(plan.key)
    this.logger.trace(
      { pluginName: plan.name, entry: toBuildEntryKey(plan.entry!) },
      'Starting Neem plugin watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: {
          id: 'plugin',
          kind: 'module',
          entry: plan.entry!,
        },
        owner: { type: 'config' },
        artifactOutDir: resolve(this.outDir, 'config', 'plugins', plan.key),
        outDir: this.outDir,
      },
      {
        onRebuild: (artifact) => {
          const initial = this.initializingPlugins.has(plan.key)
          return this.enqueue(() =>
            this.applyPluginArtifact(plan.key, artifact, { initial }),
          )
        },
        onError: (error) => {
          this.recordError(error)
        },
      },
    )

    this.pluginWatchers.set(plan.key, { watcher })

    try {
      return await watcher.ready
    } finally {
      this.initializingPlugins.delete(plan.key)
    }
  }

  private async startRuntimeWatcher(
    name: string,
    runtimeRolldown: NeemRolldownOptions | undefined,
    entry: string | URL,
    emittedArtifacts: readonly NeemArtifact[] | undefined,
  ): Promise<NeemResolvedArtifact> {
    this.initializingRuntimes.add(name)
    this.logger.trace(
      { runtimeName: name, entry: toBuildEntryKey(entry) },
      'Starting Neem runtime watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: {
          id: 'entry',
          kind: 'worker',
          entry,
          rolldown: runtimeRolldown,
        },
        owner: { type: 'runtime', name },
        outDir: this.outDir,
        emittedArtifacts,
      },
      {
        onRebuild: (artifact) => {
          const initial = this.initializingRuntimes.has(name)
          return this.enqueue(() =>
            this.applyRuntimeArtifact(name, artifact, { initial }),
          )
        },
        onError: (error) => {
          this.recordError(error)
        },
      },
    )

    this.runtimeWatchers.set(name, { watcher })

    try {
      return await watcher.ready
    } finally {
      this.initializingRuntimes.delete(name)
    }
  }

  private async startRuntimeHostWatcher(
    name: string,
    hostRolldown: NeemRolldownOptions | undefined,
    hostEntry: string | URL,
  ): Promise<NeemResolvedArtifact> {
    this.initializingRuntimeHosts.add(name)
    this.logger.trace(
      { runtimeName: name, entry: toBuildEntryKey(hostEntry) },
      'Starting Neem runtime host watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: {
          id: 'host',
          kind: 'module',
          entry: hostEntry,
          rolldown: hostRolldown,
        },
        owner: { type: 'runtime', name },
        outDir: this.outDir,
      },
      {
        onRebuild: (artifact) => {
          const initial = this.initializingRuntimeHosts.has(name)
          return this.enqueue(() =>
            this.applyRuntimeHostArtifact(name, artifact, { initial }),
          )
        },
        onError: (error) => {
          this.recordError(error)
        },
      },
    )

    this.runtimeHostWatchers.set(name, { watcher })

    try {
      return await watcher.ready
    } finally {
      this.initializingRuntimeHosts.delete(name)
    }
  }

  private async applyRuntimeArtifact(
    name: string,
    artifact: NeemResolvedArtifact,
    options: { initial: boolean },
  ): Promise<void> {
    if (this.stopped) return
    this.runtimeArtifacts.set(name, artifact)
    if (options.initial) return

    this.scheduleScopedRuntimeReload(name)
  }

  private async applyRuntimeHostArtifact(
    name: string,
    artifact: NeemResolvedArtifact,
    options: { initial: boolean },
  ): Promise<void> {
    if (this.stopped) return
    this.runtimeHostArtifacts.set(name, artifact)
    if (options.initial) return

    this.scheduleScopedRuntimeReload(name)
  }

  private async applyPluginArtifact(
    key: string,
    artifact: NeemResolvedArtifact,
    options: { initial: boolean },
  ): Promise<void> {
    if (this.stopped) return
    this.pluginArtifacts.set(key, artifact)
    if (options.initial) return

    this.scheduleFullRuntimeReload()
  }

  private async writeCurrentManifest(): Promise<NeemBuildManifest> {
    if (!this.config) {
      throw new Error('Cannot write Neem dev manifest before config is loaded')
    }

    const manifest: NeemBuildManifest = {
      schemaVersion: NEEM_MANIFEST_SCHEMA_VERSION,
      config: await createManifestConfig(
        this.config,
        this.configFile,
        this.outDir,
      ),
      plugins: this.createPluginManifestEntries(),
      runtimes: {},
    }

    for (const plan of resolveRuntimeBuildPlans(
      this.configFile,
      this.config,
      this.selectedRuntimes,
      { rolldown: mergePluginRolldownOptions(this.pluginPlans) },
    )) {
      const name = plan.name
      const artifact = this.runtimeArtifacts.get(name)
      if (!artifact) {
        throw new Error(`Compiled artifact for runtime [${name}] is missing`)
      }
      const host = this.runtimeHostArtifacts.get(name)
      manifest.runtimes![name] = {
        name,
        entry: toManifestArtifact(this.outDir, artifact),
        host: host ? toManifestArtifact(this.outDir, host) : undefined,
        artifacts: (artifact.emittedArtifacts ?? []).map((artifact) =>
          toManifestArtifact(this.outDir, artifact),
        ),
      }
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
        await this.reloadPluginHooks(manifest, this.runtime)
        await this.runtime.reload(snapshot)
      } else {
        this.logger.info('Starting Neem dev runtime...')
        this.runtime = new RuntimeServer({
          snapshot,
          failOnWorkerError: false,
          hooks: this.hooks,
        })
        await this.reloadPluginHooks(manifest, this.runtime)
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

  private async reloadNamedRuntime(
    runtimeName: string,
    manifest: NeemBuildManifest,
  ): Promise<void> {
    if (this.stopped) return

    const snapshot = this.createRuntimeSnapshot(manifest)

    try {
      if (!this.runtime) {
        await this.restartRuntime(manifest)
        return
      }

      this.logger.info({ runtimeName }, 'Reloading Neem runtime...')
      await this.runtime.reloadRuntime(runtimeName, snapshot)
      this.lifecycle = this.runtime.getSnapshot()
      this.logger.info({ runtimeName }, 'Neem runtime reloaded')
      this.resolveReady()
    } catch (error) {
      this.recordError(error)
    }
  }

  private scheduleFullRuntimeReload(): void {
    if (this.stopped) return
    this.pendingFullReload = true
    this.pendingRuntimeReloads.clear()
    this.scheduleRuntimeReload()
  }

  private scheduleScopedRuntimeReload(runtimeName: string): void {
    if (this.stopped) return
    if (!this.pendingFullReload) {
      this.pendingRuntimeReloads.add(runtimeName)
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
        for (const runtimeName of request.runtimeNames) {
          await this.reloadNamedRuntime(runtimeName, manifest)
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
      this.pendingRuntimeReloads.clear()
      return { type: 'full' }
    }

    if (this.pendingRuntimeReloads.size === 0) return undefined
    const runtimeNames = [...this.pendingRuntimeReloads]
    this.pendingRuntimeReloads.clear()
    return { type: 'runtimes', runtimeNames }
  }

  private hasPendingRuntimeReload(): boolean {
    return this.pendingFullReload || this.pendingRuntimeReloads.size > 0
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

  private createPluginManifestEntries(): NeemBuildManifest['plugins'] {
    if (this.pluginPlans.length === 0) return undefined

    return this.pluginPlans.map((plan) => {
      const artifact = this.pluginArtifacts.get(plan.key)
      if (plan.entry && !artifact) {
        throw new Error(`Compiled artifact for plugin [${plan.name}] is missing`)
      }

      return {
        name: plan.name,
        entry: artifact
          ? { file: toManifestArtifact(this.outDir, artifact).file }
          : undefined,
        options: plan.options,
      }
    })
  }

  private async reloadPluginHooks(
    manifest: NeemBuildManifest,
    server: NeemRuntimeServer,
  ): Promise<void> {
    this.removePluginHooks()
    this.pluginHookRegistrations = await registerManifestPluginHooks({
      manifest,
      outDir: this.outDir,
      mode: 'development',
      logger: this.logger,
      hooks: this.hooks,
      getHealth: () => server.getHealth(),
      cacheBust: true,
    })
  }

  private removePluginHooks(): void {
    for (const registration of this.pluginHookRegistrations
      .splice(0)
      .reverse()) {
      registration.remove()
    }
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
    global.gc?.()
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

async function importFreshDefault<T>(file: string): Promise<T> {
  const module = (await import(
    `${pathToFileURL(file).href}?t=${Date.now()}`
  )) as { default: T }
  return module.default
}
