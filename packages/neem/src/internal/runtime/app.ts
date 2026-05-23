import type { MessagePort } from 'node:worker_threads'
import { MessageChannel } from 'node:worker_threads'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemApplicationUpstream,
  NeemMode,
  NeemWorkerState,
} from '../../public/runtime.ts'
import type { NeemHostHooks } from './hooks.ts'
import type {
  NeemManagedWorkerController,
  NeemManagedWorkerHealth,
} from './managed-worker.ts'
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
import { callNeemHostHook } from './hooks.ts'
import { createNeemChildLogger } from './logger.ts'
import { NeemManagedWorker } from './managed-worker.ts'
import { NeemWorkerPool } from './worker-pool.ts'
import { resolveRuntimeWorkerEntry } from './worker-runtime.ts'

export type NeemStartedAppWorker = {
  id: string
  appName: string
  threadIndex: number
  artifact: NeemResolvedArtifact
  getState: () => NeemWorkerState
  getHealth: () => NeemStartedAppWorkerHealth
  getUpstreams: () => readonly NeemApplicationUpstream[]
  stop: () => Promise<void>
}

export type NeemStartedAppWorkerHealth = NeemManagedWorkerHealth & {
  appName: string
  threadIndex: number
  artifact: NeemResolvedArtifact
  upstreams: readonly NeemApplicationUpstream[]
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
  hooks: NeemHostHooks
  onWorkerFailure?: (
    error: Error,
    worker: NeemStartedAppWorker,
  ) => void | Promise<void>
}

export class NeemAppManager {
  private readonly pools = new Map<string, NeemAppWorkerPool>()

  constructor(private readonly options: NeemAppManagerOptions) {
    for (const appName of Object.keys(options.snapshot.manifest.apps)) {
      this.setPool(createAppWorkerPool(options.snapshot, appName))
    }
  }

  listWorkers(): readonly NeemStartedAppWorker[] {
    return [...this.pools.values()].flatMap((pool) => pool.list())
  }

  listPools(): readonly NeemStartedAppWorkerPool[] {
    return [...this.pools.values()]
  }

  getUpstreams(): readonly NeemApplicationUpstream[] {
    return this.listWorkers().flatMap((worker) => worker.getUpstreams())
  }

  async start(): Promise<void> {
    try {
      this.options.snapshot.logger.trace(
        {
          apps: [...this.pools.values()].map((pool) => ({
            name: pool.appName,
            threads: pool.list().length,
          })),
        },
        'Starting Neem app workers',
      )
      await Promise.all(
        [...this.pools.values()].map((pool) =>
          this.startPool(pool, this.options.snapshot),
        ),
      )
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.options.snapshot.logger.trace('Stopping Neem app workers')
    await Promise.all(
      [...this.pools.keys()].map((appName) => this.removePool(appName)),
    )
  }

  async reloadApp(
    appName: string,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    const nextPool = createAppWorkerPool(snapshot, appName)
    await this.removePool(appName)
    this.setPool(nextPool)

    try {
      await this.startPool(nextPool, snapshot)
      await callNeemHostHook(
        this.options.hooks,
        snapshot.logger,
        'app:reload',
        { mode: snapshot.mode, appName },
      )
    } catch (error) {
      await this.removePool(appName)
      throw error
    }
  }

  private setPool(pool: NeemAppWorkerPool): void {
    for (const worker of pool.list()) {
      worker.hooks = this.options.hooks
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
    this.pools.set(pool.appName, pool)
  }

  private async startPool(
    pool: NeemAppWorkerPool,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    await callNeemHostHook(this.options.hooks, snapshot.logger, 'app:start', {
      mode: snapshot.mode,
      appName: pool.appName,
    })
    try {
      await pool.start()
      await callNeemHostHook(this.options.hooks, snapshot.logger, 'app:ready', {
        mode: snapshot.mode,
        appName: pool.appName,
      })
    } catch (error) {
      await callNeemHostHook(this.options.hooks, snapshot.logger, 'app:fail', {
        mode: snapshot.mode,
        appName: pool.appName,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      throw error
    }
  }

  private async removePool(appName: string): Promise<void> {
    const pool = this.pools.get(appName)
    if (!pool) return

    this.pools.delete(appName)
    for (const worker of pool.list()) {
      this.options.proxyUpstreams.removeOwnerUpstreams(worker)
    }
    await pool.stop()
    await callNeemHostHook(
      this.options.hooks,
      this.options.snapshot.logger,
      'app:stop',
      { mode: this.options.snapshot.mode, appName },
    )
  }
}

function createAppWorkerPool(
  snapshot: NeemRuntimeSnapshot,
  appName: string,
): NeemAppWorkerPool {
  const appConfig = snapshot.config.apps[appName]
  if (!appConfig) {
    throw new Error(`Config for app [${appName}] is missing`)
  }

  const appArtifact = snapshot.artifacts.resolveFor(
    { type: 'app', name: appName },
    'entry',
  )
  if (!appArtifact) {
    throw new Error(`Entry artifact for app [${appName}] is missing`)
  }

  const workers = appConfig.threads.map(
    (threadOptions, threadIndex) =>
      new NeemAppWorker({
        mode: snapshot.mode,
        appName,
        threadIndex,
        threadOptions,
        configFile: snapshot.configFile,
        runtimeWorkerEntry: snapshot.runtimeWorkerEntry,
        appArtifact,
        artifacts: snapshot.artifacts.list(),
        logger: snapshot.logger,
      }),
  )
  return new NeemAppWorkerPool({ appName, workers, logger: snapshot.logger })
}

class NeemAppWorker implements NeemStartedAppWorker {
  readonly id: string
  readonly appName: string
  readonly threadIndex: number
  readonly artifact: NeemResolvedArtifact
  onReady?: (worker: NeemAppWorker) => void
  onFailure?: (error: Error) => void
  hooks?: NeemHostHooks

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
      runtimeWorkerEntry?: string | URL
      appArtifact: NeemResolvedArtifact
      artifacts: readonly NeemResolvedArtifact[]
      logger: NeemRuntimeSnapshot['logger']
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
      entry: data.runtimeWorkerEntry ?? resolveRuntimeWorkerEntry(),
      workerData,
      workerOptions: { transferList: [channel.port2] },
      logger: createNeemChildLogger(
        data.logger,
        `App/${data.appName}:${data.threadIndex}`,
      ),
      onMessage: (message, controller) => {
        this.handleMessage(message as NeemRuntimeWorkerMessage, controller)
      },
      onFailure: (error) => {
        void this.callWorkerHook('worker:fail', error)
        this.onFailure?.(error)
      },
    })
  }

  getState(): NeemWorkerState {
    return this.worker.getState()
  }

  getHealth(): NeemStartedAppWorkerHealth {
    return {
      ...this.worker.getHealth(),
      appName: this.appName,
      threadIndex: this.threadIndex,
      artifact: this.artifact,
      upstreams: this.upstreams,
    }
  }

  getUpstreams() {
    return this.upstreams
  }

  async start(): Promise<void> {
    await this.callWorkerHook('worker:start')
    try {
      await this.worker.start()
      await this.callWorkerHook('worker:ready')
    } catch (error) {
      await this.callWorkerHook(
        'worker:fail',
        error instanceof Error ? error : new Error(String(error)),
      )
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.worker.stop().finally(() => {
      this.port.close()
      this.upstreams = []
    })
    await this.callWorkerHook('worker:stop')
  }

  private handleMessage(
    message: NeemRuntimeWorkerMessage,
    controller: NeemManagedWorkerController,
  ) {
    if (message.type === 'ready') {
      this.upstreams = message.data.upstreams ?? []
      this.data.logger.trace(
        {
          appName: this.appName,
          threadIndex: this.threadIndex,
          upstreams: this.upstreams.length,
        },
        'Neem app worker ready',
      )
      this.onReady?.(this)
      controller.markReady()
      return
    }

    if (message.type === 'error') {
      const error = deserializeWorkerError(message.data)
      this.data.logger.error(
        new Error(`Neem app worker [${this.id}] failed`, { cause: error }),
      )
      controller.fail(error)
      return
    }

    if (message.type === 'stopped') {
      this.data.logger.trace(
        { appName: this.appName, threadIndex: this.threadIndex },
        'Neem app worker stopped',
      )
      controller.markStopped()
    }
  }

  private callWorkerHook(
    name: 'worker:start' | 'worker:ready' | 'worker:stop',
  ): Promise<void>
  private callWorkerHook(name: 'worker:fail', error: Error): Promise<void>
  private callWorkerHook(
    name: 'worker:start' | 'worker:ready' | 'worker:stop' | 'worker:fail',
    error?: Error,
  ): Promise<void> {
    if (!this.hooks) return Promise.resolve()
    return callNeemHostHook(this.hooks, this.data.logger, name, {
      mode: this.data.mode,
      id: this.id,
      name: `app:${this.data.appName}:${this.data.threadIndex}`,
      artifactId: this.artifact.id,
      owner: this.artifact.owner,
      error,
    })
  }
}

class NeemAppWorkerPool
  extends NeemWorkerPool<NeemAppWorker>
  implements NeemStartedAppWorkerPool
{
  readonly appName: string

  constructor(options: {
    appName: string
    workers: readonly NeemAppWorker[]
    logger: NeemRuntimeSnapshot['logger']
  }) {
    super({
      name: `app:${options.appName}`,
      workers: options.workers,
      logger: options.logger,
    })
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
