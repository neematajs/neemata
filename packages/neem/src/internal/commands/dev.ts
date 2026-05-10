import { resolve } from 'node:path'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemBuildConfig,
  NeemBuildConfigInput,
  NeemConfig,
} from '../../public/config.ts'
import type {
  NeemConfigDiscovery,
  NeemDiscoveredApp,
} from '../build/discovery.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemArtifactWatcher } from '../build/rolldown.ts'
import type {
  NeemHostLifecycleSnapshot,
  NeemHostLifecycleToken,
} from '../runtime/lifecycle.ts'
import type { NeemStartedHost } from './start.ts'
import { discoverConfigEntriesSync } from '../build/discovery.ts'
import { NEEM_MANIFEST_SCHEMA_VERSION } from '../build/manifest.ts'
import { watchArtifact } from '../build/rolldown.ts'
import { NeemHostLifecycle } from '../runtime/lifecycle.ts'
import { importDefault } from '../runtime/utils.ts'
import {
  cleanNeemOutDir,
  createConfigRolldownOptions,
  loadBuildConfig,
  toManifestArtifact,
  toManifestPath,
  writeManifest,
} from './build.ts'
import { startNeem } from './start.ts'

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
  getLifecycle: () => NeemHostLifecycleSnapshot
  getRuntime: () => NeemStartedHost | undefined
  stop: () => Promise<void>
}

type AppWatcherState = { watcher: NeemArtifactWatcher; entry: string }

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
  private configWatcher: NeemArtifactWatcher | undefined
  private runtime: NeemStartedHost | undefined
  private appWatchers = new Map<string, AppWatcherState>()
  private appArtifacts = new Map<string, NeemResolvedArtifact>()
  private operation = Promise.resolve()
  private lifecycle = new NeemHostLifecycle()
  private stopped = false
  private readySettled = false
  private closedSettled = false
  private readyResolve!: () => void
  private readyReject!: (error: Error) => void
  private closedResolve!: () => void
  private initializingApps = new Set<string>()

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
      this.lifecycle.markStopped()
      this.settleClosed()
      return
    }

    this.lifecycle.markStarting()
    await cleanNeemOutDir(this.outDir)
    await this.startConfigWatcher()
  }

  getLifecycle() {
    return this.lifecycle.getSnapshot()
  }

  getRuntime() {
    return this.runtime
  }

  async stop(): Promise<void> {
    if (this.closedSettled) return
    this.stopped = true
    const token = this.lifecycle.markStopping()

    await Promise.all(
      [...this.appWatchers.values()].map((state) => state.watcher.close()),
    )
    this.appWatchers.clear()
    await this.configWatcher?.close()
    this.configWatcher = undefined
    await this.operation.catch(() => {})
    await this.stopRuntime()
    this.rejectReady(new Error('Neem dev stopped before ready'))
    this.lifecycle.markStopped(token)
    this.settleClosed()
  }

  private async startConfigWatcher(): Promise<void> {
    this.discovery = discoverConfigEntriesSync(this.configFile)
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
    const token = this.beginRuntimeChange()

    this.discovery = discoverConfigEntriesSync(this.configFile)
    this.configArtifact = artifact
    this.config = await importDefault<NeemConfig>(artifact.file)

    await this.reconcileAppWatchers()
    await this.writeCurrentManifest()
    await this.restartRuntime(token)
  }

  private async reconcileAppWatchers(): Promise<void> {
    if (!this.config || !this.discovery) return

    const appNames = new Set(Object.keys(this.config.apps))

    await Promise.all(
      [...this.appWatchers.entries()]
        .filter(([name]) => !appNames.has(name))
        .map(async ([name, state]) => {
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

  private async startAppWatcher(
    name: string,
    buildConfigInput: NeemBuildConfigInput | undefined,
    discovered: NeemDiscoveredApp,
  ): Promise<NeemResolvedArtifact> {
    const rolldown = await loadAppBuildConfig(buildConfigInput, discovered)
    this.initializingApps.add(name)
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

    const token = this.beginRuntimeChange()
    await this.writeCurrentManifest()
    await this.restartRuntime(token)
  }

  private async writeCurrentManifest(): Promise<void> {
    if (!this.configArtifact || !this.config) return

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

    await writeManifest(this.outDir, manifest)
  }

  private async restartRuntime(
    token: NeemHostLifecycleToken | undefined,
  ): Promise<void> {
    if (this.stopped) return

    await this.stopRuntime()
    try {
      this.runtime = await startNeem({
        outDir: this.outDir,
        mode: 'development',
        failOnWorkerError: false,
      })
      this.lifecycle.markRunning(token)
      this.resolveReady()
    } catch (error) {
      this.runtime = undefined
      this.recordError(error, token)
    }
  }

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined
    if (!runtime) return

    await runtime.stop()
    await runtime.closed.catch(() => {})
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.operation = this.operation.then(task, task)
    return this.operation.catch((error) => {
      this.recordError(error)
    })
  }

  private beginRuntimeChange(): NeemHostLifecycleToken | undefined {
    if (this.readySettled) {
      return this.lifecycle.beginReload()
    }
    return undefined
  }

  private recordError(error: unknown, token?: NeemHostLifecycleToken) {
    const normalized =
      error instanceof Error
        ? error
        : new Error(String(error ?? 'Unknown error'))
    this.lifecycle.markFailed(normalized, token)
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
