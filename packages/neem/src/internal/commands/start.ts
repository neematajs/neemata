import type { MessagePort } from 'node:worker_threads'
import { resolve } from 'node:path'
import { MessageChannel } from 'node:worker_threads'

import type {
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'
import type { NeemConfig } from '../../public/config.ts'
import type {
  NeemApplicationUpstream,
  NeemMode,
  NeemWorkerState,
} from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemScopedArtifactRegistry } from '../runtime/artifact-registry.ts'
import type { NeemManagedWorkerController } from '../runtime/managed-worker.ts'
import type { NeemPluginManager, NeemStartedPlugin } from '../runtime/plugin.ts'
import type { NeemProxyUpstreamSnapshot } from '../runtime/proxy.ts'
import type {
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
} from '../runtime/worker-pool.ts'
import type {
  NeemRuntimeWorkerData,
  NeemRuntimeWorkerErrorMessage,
  NeemRuntimeWorkerMessage,
} from '../runtime/worker-protocol.ts'
import { NEEM_MANIFEST_FILE } from '../build/manifest.ts'
import { NeemManagedWorker } from '../runtime/managed-worker.ts'
import { NeemPluginManager as RuntimePluginManager } from '../runtime/plugin.ts'
import { NeemProxyUpstreamRegistry } from '../runtime/proxy.ts'
import { loadBuiltRuntimeSnapshot } from '../runtime/snapshot-loader.ts'
import { normalizeError } from '../runtime/utils.ts'
import { NeemWorkerPool } from '../runtime/worker-pool.ts'
import { resolveRuntimeWorkerEntry } from '../runtime/worker-runtime.ts'

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

export async function startNeem(
  options: NeemStartOptions = {},
): Promise<NeemStartedHost> {
  const cwd = options.cwd ?? process.cwd()
  const mode = options.mode ?? 'production'
  const failOnWorkerError = options.failOnWorkerError ?? mode === 'production'
  const outDir = resolve(cwd, options.outDir ?? 'dist')
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  const snapshot = await loadBuiltRuntimeSnapshot({ cwd, outDir, mode })
  const { manifest, config, artifacts } = snapshot
  const pluginManager = new RuntimePluginManager({ snapshot })

  const appPools = createAppWorkerPools({ mode, manifest, config, artifacts })
  const appWorkers = appPools.flatMap((pool) => pool.list())
  const host = createStartedHost({
    mode,
    outDir,
    manifestFile,
    manifest,
    artifacts,
    pluginManager,
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
    await pluginManager.start()
    await Promise.all(appPools.map((pool) => pool.start()))
  } catch (error) {
    await host.fail(normalizeError(error))
    throw error
  }

  return host
}

function createAppWorkerPools(options: {
  mode: NeemMode
  manifest: NeemBuildManifest
  config: NeemConfig
  artifacts: NeemScopedArtifactRegistry
}): NeemAppWorkerPool[] {
  const pools: NeemAppWorkerPool[] = []

  for (const [appName, appManifest] of Object.entries(options.manifest.apps)) {
    const appConfig = options.config.apps[appName]
    if (!appConfig) {
      throw new Error(`Config for app [${appName}] is missing`)
    }

    const appArtifact = options.artifacts.resolveFor(
      { type: 'app', name: appName },
      'entry',
    )!
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
  pluginManager: NeemPluginManager
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
        await options.pluginManager.stop()
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
      return options.pluginManager.list()
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
  private readonly port: MessagePort
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
    const channel = new MessageChannel()
    this.port = channel.port1

    const workerData: NeemRuntimeWorkerData = {
      kind: 'app',
      mode: this.data.mode,
      name: `app:${this.data.appName}:${this.data.threadIndex}`,
      data: {},
      artifact: this.data.appArtifact,
      artifacts: this.data.artifacts,
      port: channel.port2,
      appName: this.data.appName,
      threadIndex: this.data.threadIndex,
      threadOptions: this.data.threadOptions,
    }

    this.worker = new NeemManagedWorker({
      id: this.id,
      name: `app:${data.appName}:${data.threadIndex}`,
      artifactId: data.appArtifact.id,
      entry: resolveRuntimeWorkerEntry(),
      workerData,
      workerOptions: { transferList: [channel.port2] },
      onMessage: (message, controller) => {
        this.handleMessage(message as NeemRuntimeWorkerMessage, controller)
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
      this.port.close()
      this.upstreams = []
    })
  }

  private handleMessage(
    message: NeemRuntimeWorkerMessage,
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

function deserializeWorkerError(
  data: NeemRuntimeWorkerErrorMessage['data'],
): Error {
  const error = new Error(data.message)
  error.name = data.name ?? error.name
  error.stack = data.stack
  return error
}
