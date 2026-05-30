import { OperationQueue } from '@nmtjs/common'

import type {
  NeemRuntimeServerHealth,
  NeemRuntimeServerSnapshot,
  NeemRuntimeServerState,
} from '../../public/runtime.ts'
import type { NeemHealthProbeServer } from './health-probe.ts'
import type { NeemHostHooks } from './hooks.ts'
import type { NeemProxyManager } from './proxy.ts'
import type { NeemProxyUpstreamSnapshot } from './proxy-upstreams.ts'
import type { NeemRuntimeRecoveryOptions } from './recovery.ts'
import type {
  NeemRuntimeManager,
  NeemStartedRuntimePool,
  NeemStartedRuntimeThread,
} from './runtime.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { callNeemHostHook, createNeemHostHooks } from './hooks.ts'
import { createNeemChildLogger } from './logger.ts'
import { NeemProxyUpstreamRegistry } from './proxy-upstreams.ts'
import { normalizeError } from './utils.ts'

export type {
  NeemRuntimeServerHealth,
  NeemRuntimeServerRuntimeHealth,
  NeemRuntimeServerSnapshot,
  NeemRuntimeServerState,
} from '../../public/runtime.ts'

export type NeemRuntimeServerOptions = {
  snapshot: NeemRuntimeSnapshot
  failOnWorkerError?: boolean
  recovery?: NeemRuntimeRecoveryOptions
  hooks?: NeemHostHooks
  onFailure?: (error: Error) => void | Promise<void>
}

export class NeemRuntimeServer {
  private state: NeemRuntimeServerState = 'idle'
  private revision = 0
  private lastError: Error | undefined
  private snapshot: NeemRuntimeSnapshot
  private logger: NeemRuntimeSnapshot['logger']
  private readonly operations = new OperationQueue()
  private runtimeManager: NeemRuntimeManager | undefined
  private proxyManager: NeemProxyManager | undefined
  private healthProbe: NeemHealthProbeServer | undefined
  private proxyUpstreams = new NeemProxyUpstreamRegistry()
  private readonly hooks: NeemHostHooks

  constructor(readonly options: NeemRuntimeServerOptions) {
    this.snapshot = options.snapshot
    this.logger = createNeemChildLogger(options.snapshot.logger, 'neem:server')
    this.hooks = options.hooks ?? createNeemHostHooks()
    this.proxyUpstreams.on('add', (event) => {
      this.logger.trace(
        {
          runtimeName: event.runtimeName,
          transport: event.proxyUpstream.transport,
          url: event.upstream.url,
          count: event.count,
        },
        'Proxy upstream added',
      )
    })
    this.proxyUpstreams.on('remove', (event) => {
      this.logger.trace(
        {
          runtimeName: event.runtimeName,
          transport: event.proxyUpstream.transport,
          url: event.upstream.url,
          count: event.count,
        },
        'Proxy upstream removed',
      )
    })
  }

  getSnapshot(): NeemRuntimeServerSnapshot {
    return {
      mode: this.snapshot.mode,
      outDir: this.snapshot.outDir,
      runtimeNames: Object.keys(this.snapshot.manifest.runtimes ?? {}),
      artifactCount: this.snapshot.artifacts.list().length,
      state: this.state,
      revision: this.revision,
      lastError: this.lastError,
    }
  }

  getState(): NeemRuntimeServerState {
    return this.state
  }

  getHealth(): NeemRuntimeServerHealth {
    const runtimes = [...this.getRuntimeWorkerPools()].map((pool) => ({
      name: pool.runtimeName,
      pool: pool.getHealth(),
      threads: pool.list().map((thread) => thread.getHealth()),
    }))
    const proxy = this.proxyManager?.getHealth() ?? {
      enabled: Boolean(this.snapshot.config.proxy),
      running: false,
      ready: false,
      upstreams: [...this.proxyUpstreams.list()],
      appliedUpstreams: [],
      pending: 0,
      failedUpstreams: [],
    }

    return {
      ...this.getSnapshot(),
      ready:
        this.state === 'running' &&
        runtimes.every((runtime) => runtime.pool.state === 'ready') &&
        (!proxy.enabled || proxy.ready),
      runtimes,
      proxy,
    }
  }

  *getRuntimeWorkers(): IterableIterator<NeemStartedRuntimeThread> {
    if (!this.runtimeManager) return
    yield* this.runtimeManager.listThreads()
  }

  *getRuntimeWorkerPools(): IterableIterator<NeemStartedRuntimePool> {
    if (!this.runtimeManager) return
    yield* this.runtimeManager.listPools()
  }

  *getProxyUpstreams(): IterableIterator<NeemProxyUpstreamSnapshot> {
    yield* this.proxyUpstreams.list()
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state === 'running') return
      this.markState('starting')
      try {
        this.logLifecycle({ mode: this.snapshot.mode }, 'Starting Neem server')
        await this.syncHealthProbe(this.snapshot)
        await this.startRuntime(this.snapshot)
        this.markState('running')
        this.logLifecycle('Neem server started')
        await this.callHook('server:ready')
      } catch (error) {
        this.markState('failed', normalizeError(error))
        this.logger.error(
          new Error('Failed to start Neem server', { cause: error }),
        )
        await this.callHook('server:fail', normalizeError(error))
        throw error
      }
    })
  }

  reload(snapshot: NeemRuntimeSnapshot): Promise<void> {
    return this.enqueue(async () => {
      this.markState('reloading')
      try {
        this.logLifecycle('Reloading Neem server')
        await this.stopRuntime(this.snapshot)
        this.snapshot = snapshot
        this.logger = createNeemChildLogger(snapshot.logger, 'neem:server')
        await this.syncHealthProbe(snapshot)
        await this.startRuntime(this.snapshot)
        this.markState('running')
        this.logLifecycle('Neem server reloaded')
        await this.callHook('server:reload')
      } catch (error) {
        this.markState('failed', normalizeError(error))
        this.logger.error(
          new Error('Failed to reload Neem server', { cause: error }),
        )
        await this.callHook('server:fail', normalizeError(error))
        throw error
      }
    })
  }

  reloadRuntime(
    runtimeName: string,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.markState('reloading')
      this.snapshot = snapshot
      this.logger = createNeemChildLogger(snapshot.logger, 'neem:server')

      try {
        await this.syncHealthProbe(snapshot)
        await this.reloadRuntimeRuntime(runtimeName, snapshot)
        await this.proxyManager?.waitForSync()
        this.markState('running')
      } catch (error) {
        this.markState('failed', normalizeError(error))
        this.logger.error(
          new Error(`Failed to reload Neem runtime [${runtimeName}]`, {
            cause: error,
          }),
        )
        throw error
      }
    })
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state === 'stopped') return
      this.markState('stopping')
      try {
        this.logLifecycle('Stopping Neem server')
        await this.callHook('server:stop')
        await this.stopRuntime(this.snapshot)
      } finally {
        await this.stopHealthProbe()
        this.markState('stopped')
        this.logLifecycle('Neem server stopped')
      }
    })
  }

  protected async startRuntime(snapshot: NeemRuntimeSnapshot): Promise<void> {
    const { NeemProxyManager } = await import('./proxy.ts')
    const { NeemRuntimeManager } = await import('./runtime.ts')
    const runtimeManager = new NeemRuntimeManager({
      snapshot,
      proxyUpstreams: this.proxyUpstreams,
      hooks: this.hooks,
      recovery: this.options.recovery,
      onWorkerFailure: (error) => {
        if (this.options.failOnWorkerError) {
          this.markState('failed', error)
          void this.options.onFailure?.(error)
        }
      },
    })
    const proxyManager = snapshot.config.proxy
      ? new NeemProxyManager({ snapshot, upstreams: this.proxyUpstreams })
      : undefined

    try {
      await this.callHook('server:start')
      await runtimeManager.start()
      await proxyManager?.start()
      this.runtimeManager = runtimeManager
      this.proxyManager = proxyManager
    } catch (error) {
      await proxyManager?.stop().catch(() => undefined)
      await runtimeManager.stop().catch(() => undefined)
      throw error
    }
  }

  protected async stopRuntime(_snapshot: NeemRuntimeSnapshot): Promise<void> {
    const proxyManager = this.proxyManager
    const runtimeManager = this.runtimeManager
    this.proxyManager = undefined
    this.runtimeManager = undefined
    await proxyManager?.stop()
    await runtimeManager?.stop()
  }

  protected async syncHealthProbe(
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    const config = snapshot.config.health
    if (this.healthProbe?.matches(config)) return

    await this.stopHealthProbe()

    if (!config) return

    const { NeemHealthProbeServer } = await import('./health-probe.ts')
    const probe = new NeemHealthProbeServer({
      config,
      logger: snapshot.logger,
      getHealth: () => this.getHealth(),
    })
    await probe.start()
    this.healthProbe = probe
  }

  protected async stopHealthProbe(): Promise<void> {
    const probe = this.healthProbe
    this.healthProbe = undefined
    await probe?.stop()
  }

  protected async reloadRuntimeRuntime(
    runtimeName: string,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    if (!this.runtimeManager) {
      throw new Error('Cannot reload Neem runtime before server starts')
    }

    await this.runtimeManager.reloadRuntime(runtimeName, snapshot)
  }

  private markState(state: NeemRuntimeServerState, error?: Error): void {
    const from = this.state
    this.revision += 1
    this.state = state
    this.lastError = error
    this.logger.trace(
      { from, to: state, revision: this.revision },
      'State transition',
    )
  }

  private logLifecycle(message: string): void
  private logLifecycle(data: object, message: string): void
  private logLifecycle(dataOrMessage: object | string, message?: string): void {
    if (typeof dataOrMessage === 'string') {
      this.snapshot.mode === 'development'
        ? this.logger.trace(dataOrMessage)
        : this.logger.debug(dataOrMessage)
      return
    }

    this.snapshot.mode === 'development'
      ? this.logger.trace(dataOrMessage, message!)
      : this.logger.debug(dataOrMessage, message!)
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    return this.operations.run(task)
  }

  private callHook(
    name: 'server:start' | 'server:ready' | 'server:reload' | 'server:stop',
  ): Promise<void>
  private callHook(name: 'server:fail', error: Error): Promise<void>
  private callHook(
    name:
      | 'server:start'
      | 'server:ready'
      | 'server:reload'
      | 'server:stop'
      | 'server:fail',
    error?: Error,
  ): Promise<void> {
    return callNeemHostHook(this.hooks, this.logger, name, {
      mode: this.snapshot.mode,
      error,
    })
  }
}
