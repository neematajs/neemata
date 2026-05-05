import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parse, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

import type {
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '../public/artifact.ts'
import type { NeemConfig } from '../public/config.ts'
import type {
  NeemPlugin,
  NeemPluginContext,
  NeemPluginWorkerHandle,
  NeemPluginWorkerSpawnOptions,
  NeemPluginWorkers,
} from '../public/plugin.ts'
import type {
  NeemApplicationUpstream,
  NeemMode,
  NeemWorkerState,
} from '../public/runtime.ts'
import type {
  NeemAppWorkerData,
  NeemAppWorkerErrorMessage,
  NeemAppWorkerMessage,
} from './app-worker-protocol.ts'
import type { NeemManagedWorkerController } from './managed-worker.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from './manifest.ts'
import type { NeemProxyUpstreamSnapshot } from './proxy-upstreams.ts'
import type {
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
} from './worker-pool.ts'
import { NeemManagedWorker } from './managed-worker.ts'
import { NEEM_MANIFEST_FILE, NEEM_MANIFEST_SCHEMA_VERSION } from './manifest.ts'
import { NeemProxyUpstreamRegistry } from './proxy-upstreams.ts'
import { NeemWorkerPool } from './worker-pool.ts'

export type NeemStartOptions = {
  outDir?: string
  cwd?: string
  mode?: NeemMode
  failOnWorkerError?: boolean
  signal?: AbortSignal
}

export type NeemStartedAppWorker = {
  id: string
  appName: string
  threadIndex: number
  artifact: NeemResolvedArtifact
  getState: () => NeemWorkerState
  getUpstreams: () => readonly NeemApplicationUpstream[]
  stop: () => Promise<void>
}

export type NeemStartedAppWorkerPool = {
  appName: string
  name: string
  list: () => readonly NeemStartedAppWorker[]
  getState: () => NeemWorkerPoolState
  getHealth: () => NeemWorkerPoolHealth
}

export type NeemStartedPlugin = {
  name: string
  instanceId: number
  setup: () => Promise<void>
  stop: () => Promise<void>
}

export type NeemStartedHost = {
  mode: NeemMode
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
  artifacts: NeemArtifactRegistry
  closed: Promise<void>
  getPlugins: () => readonly NeemStartedPlugin[]
  getWorkers: () => readonly NeemStartedAppWorker[]
  getWorkerPools: () => readonly NeemStartedAppWorkerPool[]
  getUpstreams: () => readonly NeemApplicationUpstream[]
  getProxyUpstreams: () => readonly NeemProxyUpstreamSnapshot[]
  stop: () => Promise<void>
}

type EntryModule<T> = { default: T }

export async function startNeem(
  options: NeemStartOptions = {},
): Promise<NeemStartedHost> {
  const cwd = options.cwd ?? process.cwd()
  const mode = options.mode ?? 'production'
  const failOnWorkerError = options.failOnWorkerError ?? mode === 'production'
  const outDir = resolve(cwd, options.outDir ?? 'dist')
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  const manifest = await readManifest(manifestFile)
  const config = await importDefault<NeemConfig>(
    resolve(outDir, manifest.config.file),
  )
  const artifacts = createArtifactRegistry(
    resolveManifestArtifacts(outDir, manifest),
  )
  const plugins = await createStartedPlugins({
    mode,
    outDir,
    manifest,
    config,
    artifacts,
  })

  const appPools = createAppWorkerPools({
    mode,
    outDir,
    manifest,
    config,
    artifacts,
  })
  const appWorkers = appPools.flatMap((pool) => pool.list())
  const host = createStartedHost({
    mode,
    outDir,
    manifestFile,
    manifest,
    artifacts,
    plugins,
    pools: appPools,
    workers: appWorkers,
  })

  for (const worker of appWorkers) {
    worker.onReady = () => {
      host.addWorkerUpstreams(worker)
    }
    worker.onFailure = (error) => {
      host.removeWorkerUpstreams(worker)
      if (failOnWorkerError) {
        void host.fail(error)
      }
    }
  }

  if (options.signal?.aborted) {
    await host.stop()
    return host
  }

  const onAbort = () => {
    void host.stop()
  }

  options.signal?.addEventListener('abort', onAbort, { once: true })
  host.closed
    .finally(() => {
      options.signal?.removeEventListener('abort', onAbort)
    })
    .catch(() => {})

  try {
    for (const plugin of plugins) {
      await plugin.setup()
    }
    await Promise.all(appPools.map((pool) => pool.start()))
  } catch (error) {
    await host.fail(normalizeError(error))
    throw error
  }

  return host
}

async function readManifest(manifestFile: string): Promise<NeemBuildManifest> {
  const raw = JSON.parse(await readFile(manifestFile, 'utf8')) as unknown
  if (!isManifest(raw)) {
    throw new Error(`Invalid Neem manifest at [${manifestFile}]`)
  }

  return raw
}

function isManifest(value: unknown): value is NeemBuildManifest {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as NeemBuildManifest).schemaVersion ===
        NEEM_MANIFEST_SCHEMA_VERSION &&
      typeof (value as NeemBuildManifest).config?.file === 'string' &&
      typeof (value as NeemBuildManifest).apps === 'object' &&
      Array.isArray((value as NeemBuildManifest).plugins),
  )
}

function resolveManifestArtifacts(
  outDir: string,
  manifest: NeemBuildManifest,
): NeemResolvedArtifact[] {
  const artifacts: NeemResolvedArtifact[] = []

  for (const app of Object.values(manifest.apps)) {
    artifacts.push(resolveManifestArtifact(outDir, app.entry))
  }

  for (const plugin of manifest.plugins) {
    artifacts.push(resolveManifestArtifact(outDir, plugin.entry))
    for (const artifact of plugin.artifacts) {
      artifacts.push(resolveManifestArtifact(outDir, artifact))
    }
  }

  return artifacts
}

function resolveManifestArtifact(
  outDir: string,
  artifact: NeemBuildManifestArtifact,
): NeemResolvedArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind as NeemResolvedArtifact['kind'],
    owner: artifact.owner,
    file: resolve(outDir, artifact.file),
    outDir: resolve(outDir, artifact.outDir),
  }
}

function createArtifactRegistry(
  artifacts: readonly NeemResolvedArtifact[],
): NeemArtifactRegistry {
  const byId = new Map<string, NeemResolvedArtifact>()
  for (const artifact of artifacts) {
    if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
  }

  return Object.freeze({
    resolve(id: string) {
      return byId.get(id)
    },
    list() {
      return artifacts
    },
  })
}

async function createStartedPlugins(options: {
  mode: NeemMode
  outDir: string
  manifest: NeemBuildManifest
  config: NeemConfig
  artifacts: NeemArtifactRegistry
}): Promise<NeemStartedPlugin[]> {
  const plugins: NeemStartedPlugin[] = []

  for (const pluginManifest of options.manifest.plugins) {
    const entry = resolveManifestArtifact(options.outDir, pluginManifest.entry)
    const plugin = await importDefault<NeemPlugin<any>>(entry.file)
    if (!isPlugin(plugin)) {
      throw new Error(
        `Plugin [${pluginManifest.name}] entry default export does not satisfy NeemPlugin`,
      )
    }

    const config = options.config.plugins?.[pluginManifest.index]
    plugins.push(
      new NeemStartedHostPlugin({
        mode: options.mode,
        name: plugin.name,
        instanceId: pluginManifest.index,
        options: config?.options,
        plugin,
        artifacts: options.artifacts,
      }),
    )
  }

  return plugins
}

function isPlugin(value: unknown): value is NeemPlugin<any> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as NeemPlugin).name === 'string',
  )
}

function createAppWorkerPools(options: {
  mode: NeemMode
  outDir: string
  manifest: NeemBuildManifest
  config: NeemConfig
  artifacts: NeemArtifactRegistry
}): NeemAppWorkerPool[] {
  const pools: NeemAppWorkerPool[] = []

  for (const [appName, appManifest] of Object.entries(options.manifest.apps)) {
    const appConfig = options.config.apps[appName]
    if (!appConfig) {
      throw new Error(`Config for app [${appName}] is missing`)
    }

    const appArtifact = resolveManifestArtifact(
      options.outDir,
      appManifest.entry,
    )
    const workers = appConfig.threads.map(
      (threadOptions, threadIndex) =>
        new NeemAppWorker({
          mode: options.mode,
          appName,
          threadIndex,
          threadOptions,
          appArtifact,
          artifacts: options.artifacts.list(),
        }),
    )
    pools.push(new NeemAppWorkerPool({ appName, workers }))
  }

  return pools
}

function createStartedHost(options: {
  mode: NeemMode
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
  artifacts: NeemArtifactRegistry
  plugins: NeemStartedPlugin[]
  pools: NeemAppWorkerPool[]
  workers: NeemAppWorker[]
}) {
  let stopPromise: Promise<void> | undefined
  let closedSettled = false
  let closeResolve!: () => void
  let closeReject!: (error: Error) => void
  let failure: Error | undefined
  const proxyUpstreams = new NeemProxyUpstreamRegistry()

  const closed = new Promise<void>((resolve, reject) => {
    closeResolve = resolve
    closeReject = reject
  })
  closed.catch(() => {})

  const settleClosed = (error?: Error) => {
    if (closedSettled) return
    closedSettled = true
    if (error) closeReject(error)
    else closeResolve()
  }

  const stopWorkers = async () => {
    stopPromise ??= (async () => {
      try {
        for (const worker of options.workers) {
          proxyUpstreams.removeOwnerUpstreams(worker)
        }
        await Promise.all(options.pools.map((pool) => pool.stop()))
        for (const plugin of options.plugins.toReversed()) {
          await plugin.stop()
        }
      } finally {
        settleClosed(failure)
      }
    })().then(() => undefined)
    return stopPromise
  }

  const host = {
    mode: options.mode,
    outDir: options.outDir,
    manifestFile: options.manifestFile,
    manifest: options.manifest,
    artifacts: options.artifacts,
    closed,
    getPlugins() {
      return options.plugins
    },
    getWorkers() {
      return options.workers
    },
    getWorkerPools() {
      return options.pools
    },
    getUpstreams() {
      return options.workers.flatMap((worker) => worker.getUpstreams())
    },
    getProxyUpstreams() {
      return proxyUpstreams.list()
    },
    addWorkerUpstreams(worker: NeemAppWorker) {
      proxyUpstreams.addOwnerUpstreams(
        worker,
        worker.appName,
        worker.getUpstreams(),
      )
    },
    removeWorkerUpstreams(worker: NeemAppWorker) {
      proxyUpstreams.removeOwnerUpstreams(worker)
    },
    stop: stopWorkers,
    async fail(error: Error) {
      failure ??= error
      await stopWorkers()
    },
  }

  return host
}

class NeemAppWorker implements NeemStartedAppWorker {
  readonly id: string
  readonly appName: string
  readonly threadIndex: number
  readonly artifact: NeemResolvedArtifact
  onReady?: (worker: NeemAppWorker) => void
  onFailure?: (error: Error) => void

  private readonly worker: NeemManagedWorker
  private upstreams: readonly NeemApplicationUpstream[] = []

  constructor(
    private readonly data: {
      appName: string
      mode: NeemMode
      threadIndex: number
      threadOptions: unknown
      appArtifact: NeemResolvedArtifact
      artifacts: readonly NeemResolvedArtifact[]
    },
  ) {
    this.id = `${data.appName}:${data.threadIndex}`
    this.appName = data.appName
    this.threadIndex = data.threadIndex
    this.artifact = data.appArtifact
    const workerData: NeemAppWorkerData = {
      appName: this.data.appName,
      mode: this.data.mode,
      threadIndex: this.data.threadIndex,
      threadOptions: this.data.threadOptions,
      appArtifact: this.data.appArtifact,
      artifacts: this.data.artifacts,
    }

    this.worker = new NeemManagedWorker({
      id: this.id,
      name: `app:${data.appName}:${data.threadIndex}`,
      artifactId: data.appArtifact.id,
      entry: resolveAppWorkerEntry(),
      workerData,
      onMessage: (message, controller) => {
        this.handleMessage(message as NeemAppWorkerMessage, controller)
      },
      onFailure: (error) => {
        this.onFailure?.(error)
      },
    })
  }

  getState(): NeemWorkerState {
    return this.worker.getState()
  }

  getUpstreams() {
    return this.upstreams
  }

  start(): Promise<void> {
    return this.worker.start()
  }

  stop(): Promise<void> {
    return this.worker.stop().finally(() => {
      this.upstreams = []
    })
  }

  private handleMessage(
    message: NeemAppWorkerMessage,
    controller: NeemManagedWorkerController,
  ) {
    if (message.type === 'ready') {
      this.upstreams = message.data.upstreams ?? []
      this.onReady?.(this)
      controller.markReady()
      return
    }

    if (message.type === 'error') {
      controller.fail(deserializeWorkerError(message.data))
      return
    }

    if (message.type === 'stopped') {
      controller.markStopped()
    }
  }
}

class NeemAppWorkerPool
  extends NeemWorkerPool<NeemAppWorker>
  implements NeemStartedAppWorkerPool
{
  readonly appName: string

  constructor(options: { appName: string; workers: readonly NeemAppWorker[] }) {
    super({ name: `app:${options.appName}`, workers: options.workers })
    this.appName = options.appName
  }
}

class NeemStartedHostPlugin implements NeemStartedPlugin {
  readonly name: string
  readonly instanceId: number

  private readonly workers: NeemPluginWorkerRegistry
  private setupComplete = false

  constructor(
    private readonly options: {
      mode: NeemMode
      name: string
      instanceId: number
      options: unknown
      plugin: NeemPlugin<any>
      artifacts: NeemArtifactRegistry
    },
  ) {
    this.name = options.name
    this.instanceId = options.instanceId
    this.workers = new NeemPluginWorkerRegistry({
      pluginName: options.name,
      instanceId: options.instanceId,
      artifacts: options.artifacts,
    })
  }

  async setup(): Promise<void> {
    if (this.setupComplete) return
    await this.options.plugin.setup?.(this.createContext())
    this.setupComplete = true
  }

  async stop(): Promise<void> {
    try {
      if (this.setupComplete) {
        await this.options.plugin.stop?.(this.createContext())
      }
    } finally {
      await this.workers.stopAll()
      this.setupComplete = false
    }
  }

  private createContext(): NeemPluginContext<any> {
    return {
      mode: this.options.mode,
      name: this.options.name,
      instanceId: this.options.instanceId,
      options: this.options.options,
      artifacts: this.options.artifacts,
      workers: this.workers,
    }
  }
}

class NeemPluginWorkerRegistry implements NeemPluginWorkers {
  private readonly workers = new Map<
    string,
    NeemManagedWorker & NeemPluginWorkerHandle
  >()

  constructor(
    private readonly options: {
      pluginName: string
      instanceId: number
      artifacts: NeemArtifactRegistry
    },
  ) {}

  async spawn(
    options: NeemPluginWorkerSpawnOptions,
  ): Promise<NeemPluginWorkerHandle> {
    const artifact =
      typeof options.artifact === 'string'
        ? this.options.artifacts.resolve(options.artifact)
        : options.artifact
    if (!artifact) {
      throw new Error(
        `Plugin worker artifact [${String(options.artifact)}] was not found`,
      )
    }

    const id =
      options.id ??
      `${this.options.instanceId}:${this.options.pluginName}:${options.name}`
    const channel = new MessageChannel()
    const worker = Object.assign(
      new NeemManagedWorker({
        id,
        name: `plugin:${this.options.pluginName}:${options.name}`,
        artifactId: artifact.id,
        entry: pathToFileURL(artifact.file),
        workerData: { ...(options.workerData ?? {}), port: channel.port2 },
        workerOptions: { transferList: [channel.port2] },
        onMessage(message, controller) {
          if (!message || typeof message !== 'object') return
          const type = (message as { type?: string }).type
          if (type === 'ready') {
            controller.markReady()
            return
          }
          if (type === 'stopped') {
            controller.markStopped()
            return
          }
          if (type === 'error') {
            const data = (message as { data?: unknown }).data
            controller.fail(deserializeGenericWorkerError(data))
          }
        },
      }),
      { port: channel.port1 },
    )
    this.workers.set(id, worker)
    try {
      await worker.start()
    } catch (error) {
      this.workers.delete(id)
      throw error
    }
    return worker
  }

  async stop(workerId: string): Promise<boolean> {
    const worker = this.workers.get(workerId)
    if (!worker) return false
    await worker.stop()
    worker.port.close()
    this.workers.delete(workerId)
    return true
  }

  list(): readonly NeemPluginWorkerHandle[] {
    return [...this.workers.values()]
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.workers.keys()].map((workerId) => this.stop(workerId)),
    )
  }
}

async function importDefault<T>(file: string): Promise<T> {
  const module: EntryModule<T> = await import(pathToFileURL(file).href)
  return module.default
}

function resolveAppWorkerEntry(): URL {
  const currentPath = fileURLToPath(import.meta.url)
  const currentFile = parse(currentPath)
  const entry = new URL(`./app-worker-entry${currentFile.ext}`, import.meta.url)
  return entry
}

function deserializeWorkerError(
  data: NeemAppWorkerErrorMessage['data'],
): Error {
  const error = new Error(data.message)
  error.name = data.name ?? error.name
  error.stack = data.stack
  return error
}

function deserializeGenericWorkerError(data: unknown): Error {
  if (data && typeof data === 'object' && 'message' in data) {
    const error = new Error(String((data as { message: unknown }).message))
    if ('name' in data && typeof data.name === 'string') {
      error.name = data.name
    }
    if ('stack' in data && typeof data.stack === 'string') {
      error.stack = data.stack
    }
    return error
  }

  return normalizeError(data)
}

function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}
