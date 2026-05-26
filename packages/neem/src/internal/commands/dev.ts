import type { FSWatcher } from 'node:fs'
import { unwatchFile, watch, watchFile } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { debounce } from 'perfect-debounce'

import type {
  NeemArtifact,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'
import type {
  NeemBuildConfig,
  NeemBuildConfigInput,
  NeemConfig,
  NeemRuntimeBuildConfig,
  NeemRuntimeBuildInput,
  NeemRuntimeConfigBase,
} from '../../public/config.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemArtifactWatcher } from '../build/rolldown.ts'
import type { NeemHostHooks } from '../runtime/hooks.ts'
import type {
  NeemRuntimeServer,
  NeemRuntimeServerHealth,
  NeemRuntimeServerSnapshot,
} from '../runtime/server.ts'
import { resolveNeemConfigLogger } from '../build/logger.ts'
import { NEEM_MANIFEST_SCHEMA_VERSION } from '../build/manifest.ts'
import { resolveImportFile } from '../build/resolve.ts'
import { watchArtifact } from '../build/rolldown.ts'
import { createNeemDefaultLogger } from '../runtime/logger.ts'
import { NeemRuntimeServer as RuntimeServer } from '../runtime/server.ts'
import { createRuntimeSnapshot } from '../runtime/snapshot.ts'
import { importDefault } from '../runtime/utils.ts'
import {
  cleanNeemOutDir,
  createManifestConfig,
  loadBuildConfig,
  toManifestArtifact,
  writeManifest,
} from './build.ts'

export type NeemDevOptions = {
  config?: string
  outDir?: string
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

type RuntimeWatcherState = { watcher: NeemArtifactWatcher; entry: string }
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

export async function devNeem(
  options: NeemDevOptions = {},
): Promise<NeemDevHost> {
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

  private config: NeemConfig | undefined
  private logger = createNeemDefaultLogger('development')
  private configWatcher: FSWatcher | undefined
  private watchesConfigFile = false
  private runtime: NeemRuntimeServer | undefined
  private runtimeWatchers = new Map<string, RuntimeWatcherState>()
  private runtimeArtifacts = new Map<string, NeemResolvedArtifact>()
  private runtimeHostWatchers = new Map<string, RuntimeWatcherState>()
  private runtimeHostArtifacts = new Map<string, NeemResolvedArtifact>()
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
  private scheduleConfigApply = debounce(
    () => this.enqueue(() => this.applyConfig()),
    NEEM_DEV_RELOAD_DEBOUNCE_MS,
  )
  private readySettled = false
  private closedSettled = false
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private closedResolve!: () => void
  private readonly selectedRuntimes: readonly string[] | undefined
  private readonly hooks: NeemHostHooks | undefined
  private initializingRuntimes = new Set<string>()
  private initializingRuntimeHosts = new Set<string>()

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
    this.hooks = options.hooks
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
    this.scheduleConfigApply.cancel()
    await this.stopRuntimeWatchers()
    await this.configWatcher?.close()
    if (this.watchesConfigFile) {
      unwatchFile(this.configFile)
      this.watchesConfigFile = false
    }
    this.configWatcher = undefined
    await this.operation.catch(() => {})
    await this.runtimeOperation.catch(() => {})
    await this.stopRuntime()
    this.rejectReady(new Error('Neem dev stopped before ready'))
    this.lifecycle = { state: 'stopped' }
    this.logger.info('Neem dev session stopped')
    this.settleClosed()
  }

  private async stopRuntimeWatchers(): Promise<void> {
    const watchers = [
      ...this.runtimeWatchers.values(),
      ...this.runtimeHostWatchers.values(),
    ]
    this.logger.debug(
      { count: watchers.length },
      'Closing Neem runtime watchers',
    )
    this.runtimeWatchers.clear()
    this.runtimeArtifacts.clear()
    this.runtimeHostWatchers.clear()
    this.runtimeHostArtifacts.clear()
    await Promise.all(watchers.map((state) => state.watcher.close()))
  }

  private async startConfigWatcher(): Promise<void> {
    this.logger.trace(
      { configFile: this.configFile },
      'Starting Neem config watcher',
    )
    await this.applyConfig()
    this.configWatcher = watch(this.configFile, () => {
      void this.scheduleConfigApply()
    })
    watchFile(this.configFile, { interval: 100 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs) {
        void this.scheduleConfigApply()
      }
    })
    this.watchesConfigFile = true
    this.configWatcher.on('error', (error) => {
      this.recordError(error)
    })
  }

  private async applyConfig(): Promise<void> {
    if (this.stopped) return
    this.beginRuntimeChange()

    this.config = await importFreshDefault<NeemConfig>(this.configFile)
    this.assertSelectedRuntimesExist()
    this.logger = await resolveNeemConfigLogger(this.config, {
      mode: 'development',
      importer: this.configFile,
    })
    this.logger.trace({ file: this.configFile }, 'Neem config loaded')

    await this.reconcileRuntimeWatchers()
    this.scheduleFullRuntimeReload()
  }

  private async reconcileRuntimeWatchers(): Promise<void> {
    if (!this.config) return

    const runtimeEntries = Object.entries(this.config.runtimes ?? {}).filter(
      ([name]) => this.shouldUseRuntime(name),
    )
    const runtimeNames = new Set(runtimeEntries.map(([name]) => name))

    await Promise.all(
      [...this.runtimeWatchers.entries()]
        .filter(([name]) => !runtimeNames.has(name))
        .map(([name]) => this.removeRuntime(name)),
    )

    for (const [name, runtimeConfig] of runtimeEntries) {
      const current = this.runtimeWatchers.get(name)
      const runtimeBuild = getRuntimeBuildConfig(runtimeConfig.build)
      const entry = resolveRequiredRuntimeBuildEntry(
        this.configFile,
        runtimeConfig.entry,
      )
      const emittedArtifacts = resolveRuntimeBuildArtifacts(
        this.configFile,
        runtimeBuild?.artifacts,
      )
      const runtimeEntryKey = [
        entry,
        runtimeBuildArtifactsKey(emittedArtifacts),
      ].join('\0')
      if (current?.entry !== runtimeEntryKey) {
        if (current) await this.removeRuntime(name)
        const artifact = await this.startRuntimeWatcher(
          name,
          runtimeBuild?.config,
          runtimeBuild?.rolldown,
          entry,
          emittedArtifacts,
          runtimeEntryKey,
        )
        this.runtimeArtifacts.set(name, artifact)
      }

      const hostCurrent = this.runtimeHostWatchers.get(name)
      const hostEntry =
        resolveRuntimeHostEntry(this.configFile, runtimeConfig.host) ??
        resolveRuntimeBuildEntry(this.configFile, runtimeBuild?.host?.entry)
      if (hostEntry) {
        const hostEntryKey = toWatcherEntryKey(hostEntry)
        if (hostCurrent?.entry !== hostEntryKey) {
          if (hostCurrent) {
            await hostCurrent.watcher.close()
            this.runtimeHostWatchers.delete(name)
            this.runtimeHostArtifacts.delete(name)
          }
          const artifact = await this.startRuntimeHostWatcher(
            name,
            runtimeConfig,
            hostEntry,
          )
          this.runtimeHostArtifacts.set(name, artifact)
        }
      } else if (hostCurrent) {
        await hostCurrent.watcher.close()
        this.runtimeHostWatchers.delete(name)
        this.runtimeHostArtifacts.delete(name)
      }
    }
  }

  private async removeRuntime(name: string): Promise<void> {
    this.logger.debug({ runtimeName: name }, 'Removing Neem runtime watcher')
    const watcher = this.runtimeWatchers.get(name)
    const hostWatcher = this.runtimeHostWatchers.get(name)
    this.runtimeWatchers.delete(name)
    this.runtimeArtifacts.delete(name)
    this.runtimeHostWatchers.delete(name)
    this.runtimeHostArtifacts.delete(name)
    await Promise.all([watcher?.watcher.close(), hostWatcher?.watcher.close()])
  }

  private async startRuntimeWatcher(
    name: string,
    buildConfigInput: NeemBuildConfigInput | undefined,
    runtimeBuildRolldown: NeemBuildConfig | undefined,
    entry: string | URL,
    emittedArtifacts: NeemRuntimeBuildConfig['artifacts'] | undefined,
    entryKey: string,
  ): Promise<NeemResolvedArtifact> {
    const rolldown = await loadRuntimeBuildConfig(
      buildConfigInput,
      this.configFile,
    )
    this.initializingRuntimes.add(name)
    this.logger.trace(
      { runtimeName: name, entry: toWatcherEntryKey(entry) },
      'Starting Neem runtime watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: {
          id: 'entry',
          kind: 'worker',
          entry,
          rolldown: runtimeBuildRolldown,
        },
        owner: { type: 'runtime', name },
        rolldown,
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

    this.runtimeWatchers.set(name, { watcher, entry: entryKey })

    try {
      return await watcher.ready
    } finally {
      this.initializingRuntimes.delete(name)
    }
  }

  private async startRuntimeHostWatcher(
    name: string,
    runtimeConfig: NeemRuntimeConfigBase,
    hostEntry: string | URL,
  ): Promise<NeemResolvedArtifact> {
    if (!hostEntry) {
      throw new Error(`Runtime [${name}] host entry is missing`)
    }

    const rolldown = await loadRuntimeHostBuildConfig(
      runtimeConfig,
      this.configFile,
    )
    this.initializingRuntimeHosts.add(name)
    this.logger.trace(
      { runtimeName: name, entry: toWatcherEntryKey(hostEntry) },
      'Starting Neem runtime host watcher',
    )
    const watcher = await watchArtifact(
      {
        artifact: { id: 'host', kind: 'module', entry: hostEntry },
        owner: { type: 'runtime', name },
        rolldown,
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

    this.runtimeHostWatchers.set(name, {
      watcher,
      entry: toWatcherEntryKey(hostEntry),
    })

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
      runtimes: {},
    }

    for (const name of Object.keys(this.config.runtimes ?? {}).filter((name) =>
      this.shouldUseRuntime(name),
    )) {
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
        await this.runtime.reload(snapshot)
      } else {
        this.logger.info('Starting Neem dev runtime...')
        this.runtime = new RuntimeServer({
          snapshot,
          failOnWorkerError: false,
          hooks: this.hooks,
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

  private shouldUseRuntime(name: string): boolean {
    return !this.selectedRuntimes || this.selectedRuntimes.includes(name)
  }

  private assertSelectedRuntimesExist(): void {
    if (!this.config || !this.selectedRuntimes) return
    const available = Object.keys(this.config.runtimes ?? {})
    const missing = this.selectedRuntimes.filter(
      (name) => !available.includes(name),
    )
    if (missing.length > 0) {
      throw new Error(`Unknown Neem runtime(s): ${missing.join(', ')}`)
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

async function loadRuntimeBuildConfig(
  input: NeemBuildConfigInput | undefined,
  importer: string,
): Promise<NeemBuildConfig | undefined> {
  return loadBuildConfig(input, importer)
}

async function loadRuntimeHostBuildConfig(
  runtimeConfig: NeemRuntimeConfigBase,
  importer: string,
): Promise<NeemBuildConfig | undefined> {
  const runtimeBuild = getRuntimeBuildConfig(runtimeConfig.build)
  if (runtimeBuild?.host?.build) {
    return loadBuildConfig(runtimeBuild.host.build, importer)
  }

  return loadBuildConfig(
    getRuntimeHostConfig(runtimeConfig.host)?.build,
    importer,
  )
}

function getRuntimeBuildConfig(
  input: NeemRuntimeBuildInput | undefined,
): NeemRuntimeBuildConfig | undefined {
  if (!input) return undefined
  return typeof input === 'string' || input instanceof URL
    ? { config: input }
    : input
}

function toWatcherEntryKey(entry: string | URL): string {
  return entry instanceof URL ? fileURLToPath(entry) : entry
}

function getRuntimeHostConfig(
  input: NeemRuntimeConfigBase['host'],
): { entry: NeemArtifact['entry']; build?: NeemBuildConfigInput } | undefined {
  if (!input) return undefined
  return typeof input === 'string' || input instanceof URL
    ? { entry: input }
    : input
}

function resolveRuntimeHostEntry(
  importer: string,
  input: NeemRuntimeConfigBase['host'],
): NeemArtifact['entry'] | undefined {
  const host = getRuntimeHostConfig(input)
  return host ? resolveRuntimeBuildEntry(importer, host.entry) : undefined
}

function resolveRuntimeBuildArtifacts(
  importer: string,
  artifacts: readonly NeemArtifact[] | undefined,
): readonly NeemArtifact[] | undefined {
  return artifacts?.map((artifact) => ({
    ...artifact,
    entry: resolveRequiredRuntimeBuildEntry(importer, artifact.entry),
  }))
}

function resolveRequiredRuntimeBuildEntry(
  importer: string,
  entry: NeemArtifact['entry'],
): NeemArtifact['entry'] {
  return resolveRuntimeBuildEntry(importer, entry) ?? entry
}

function resolveRuntimeBuildEntry(
  importer: string,
  entry: NeemArtifact['entry'] | undefined,
): NeemArtifact['entry'] | undefined {
  if (!entry) return undefined
  if (entry instanceof URL) return entry
  if (entry.startsWith('/')) return entry
  if (entry.startsWith('.')) return resolve(dirname(importer), entry)
  return resolveImportFile(importer, entry)
}

function runtimeBuildArtifactsKey(
  artifacts: readonly NeemArtifact[] | undefined,
): string {
  return JSON.stringify(
    (artifacts ?? []).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      entry:
        artifact.entry instanceof URL ? artifact.entry.href : artifact.entry,
    })),
  )
}

function normalizeSelectedRuntimeNames(
  runtimes: readonly string[] | undefined,
): readonly string[] | undefined {
  const selected = runtimes?.map((runtime) => runtime.trim()).filter(Boolean)
  return selected && selected.length > 0 ? [...new Set(selected)] : undefined
}

async function importFreshDefault<T>(file: string): Promise<T> {
  const module = (await import(
    `${pathToFileURL(file).href}?t=${Date.now()}`
  )) as { default: T }
  return module.default
}
