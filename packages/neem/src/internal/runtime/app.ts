import type { MessagePort } from 'node:worker_threads'
import { MessageChannel } from 'node:worker_threads'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemApplicationUpstream,
  NeemMode,
  NeemWorkerState,
} from '../../public/runtime.ts'
import type { NeemManagedWorkerController } from './managed-worker.ts'
import type { NeemProxyUpstreamRegistry } from './proxy.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import type {
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
} from './worker-pool.ts'
import type {
  NeemRuntimeWorkerData,
  NeemRuntimeWorkerErrorMessage,
  NeemRuntimeWorkerMessage,
} from './worker-protocol.ts'
import { NeemManagedWorker } from './managed-worker.ts'
import { NeemWorkerPool } from './worker-pool.ts'
import { resolveRuntimeWorkerEntry } from './worker-runtime.ts'

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

export type NeemAppManagerOptions = {
  snapshot: NeemRuntimeSnapshot
  proxyUpstreams: NeemProxyUpstreamRegistry
  onWorkerFailure?: (
    error: Error,
    worker: NeemStartedAppWorker,
  ) => void | Promise<void>
}

export class NeemAppManager {
  private readonly pools: NeemAppWorkerPool[]
  private readonly workers: NeemAppWorker[]

  constructor(private readonly options: NeemAppManagerOptions) {
    this.pools = createAppWorkerPools(options.snapshot)
    this.workers = this.pools.flatMap((pool) => pool.list())

    for (const worker of this.workers) {
      worker.onReady = () => {
        this.options.proxyUpstreams.addOwnerUpstreams(
          worker,
          worker.appName,
          worker.getUpstreams(),
        )
      }
      worker.onFailure = (error) => {
        this.options.proxyUpstreams.removeOwnerUpstreams(worker)
        void this.options.onWorkerFailure?.(error, worker)
      }
    }
  }

  listWorkers(): readonly NeemStartedAppWorker[] {
    return this.workers
  }

  listPools(): readonly NeemStartedAppWorkerPool[] {
    return this.pools
  }

  getUpstreams(): readonly NeemApplicationUpstream[] {
    return this.workers.flatMap((worker) => worker.getUpstreams())
  }

  async start(): Promise<void> {
    try {
      await Promise.all(this.pools.map((pool) => pool.start()))
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    for (const worker of this.workers) {
      this.options.proxyUpstreams.removeOwnerUpstreams(worker)
    }
    await Promise.all(this.pools.map((pool) => pool.stop()))
  }
}

function createAppWorkerPools(
  snapshot: NeemRuntimeSnapshot,
): NeemAppWorkerPool[] {
  const pools: NeemAppWorkerPool[] = []

  for (const appName of Object.keys(snapshot.manifest.apps)) {
    const appConfig = snapshot.config.apps[appName]
    if (!appConfig) {
      throw new Error(`Config for app [${appName}] is missing`)
    }

    const appArtifact = snapshot.artifacts.resolveFor(
      { type: 'app', name: appName },
      'entry',
    )!
    const workers = appConfig.threads.map(
      (threadOptions, threadIndex) =>
        new NeemAppWorker({
          mode: snapshot.mode,
          appName,
          threadIndex,
          threadOptions,
          configFile: snapshot.configFile,
          appArtifact,
          artifacts: snapshot.artifacts.list(),
        }),
    )
    pools.push(new NeemAppWorkerPool({ appName, workers }))
  }

  return pools
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
      configFile: string
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
      configFile: this.data.configFile,
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
