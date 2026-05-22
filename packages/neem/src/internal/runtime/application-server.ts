import type { NeemMode } from '../../public/index.ts'
import type { NeemStartedAppWorker, NeemStartedAppWorkerPool } from './app.ts'
import type { NeemHostHooks } from './hooks.ts'
import type { NeemPluginManager, NeemStartedPlugin } from './plugin.ts'
import type { NeemProxyManager, NeemProxyUpstreamSnapshot } from './proxy.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { NeemAppManager } from './app.ts'
import { callNeemHostHook, createNeemHostHooks } from './hooks.ts'
import { createNeemChildLogger } from './logger.ts'
import { NeemProxyUpstreamRegistry } from './proxy.ts'
import { normalizeError } from './utils.ts'

export type NeemApplicationServerOptions = {
  snapshot: NeemRuntimeSnapshot
  failOnWorkerError?: boolean
  onFailure?: (error: Error) => void | Promise<void>
}

export type NeemApplicationServerState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'reloading'
  | 'failed'
  | 'stopping'
  | 'stopped'

export type NeemApplicationServerSnapshot = {
  mode: NeemMode
  outDir: string
  appNames: readonly string[]
  pluginNames: readonly string[]
  artifactCount: number
  state: NeemApplicationServerState
  revision: number
  lastError?: Error
}

export class NeemApplicationServer {
  private state: NeemApplicationServerState = 'idle'
  private revision = 0
  private lastError: Error | undefined
  private snapshot: NeemRuntimeSnapshot
  private logger: NeemRuntimeSnapshot['logger']
  private operation = Promise.resolve()
  private pluginManager: NeemPluginManager | undefined
  private appManager: NeemAppManager | undefined
  private proxyManager: NeemProxyManager | undefined
  private proxyUpstreams = new NeemProxyUpstreamRegistry()
  private readonly hooks: NeemHostHooks = createNeemHostHooks()

  constructor(readonly options: NeemApplicationServerOptions) {
    this.snapshot = options.snapshot
    this.logger = options.snapshot.logger
    this.proxyUpstreams.on('add', (event) => {
      this.logger.trace(
        {
          appName: event.appName,
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
          appName: event.appName,
          transport: event.proxyUpstream.transport,
          url: event.upstream.url,
          count: event.count,
        },
        'Proxy upstream removed',
      )
    })
  }

  getSnapshot(): NeemApplicationServerSnapshot {
    return {
      mode: this.snapshot.mode,
      outDir: this.snapshot.outDir,
      appNames: Object.keys(this.snapshot.manifest.apps),
      pluginNames: this.snapshot.manifest.plugins.map((plugin) => plugin.name),
      artifactCount: this.snapshot.artifacts.list().length,
      state: this.state,
      revision: this.revision,
      lastError: this.lastError,
    }
  }

  getState(): NeemApplicationServerState {
    return this.state
  }

  getAppWorkers(): readonly NeemStartedAppWorker[] {
    return this.appManager?.listWorkers() ?? []
  }

  getAppWorkerPools(): readonly NeemStartedAppWorkerPool[] {
    return this.appManager?.listPools() ?? []
  }

  getProxyUpstreams(): readonly NeemProxyUpstreamSnapshot[] {
    return this.proxyUpstreams.list()
  }

  getPlugins(): readonly NeemStartedPlugin[] {
    return this.pluginManager?.list() ?? []
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state === 'running') return
      this.markState('starting')
      try {
        this.logLifecycle({ mode: this.snapshot.mode }, 'Starting Neem server')
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
        this.logger = createNeemChildLogger(snapshot.logger, 'Neem server')
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

  reloadApp(appName: string, snapshot: NeemRuntimeSnapshot): Promise<void> {
    return this.enqueue(async () => {
      this.markState('reloading')
      this.snapshot = snapshot
      this.logger = createNeemChildLogger(snapshot.logger, 'Neem server')

      try {
        await this.reloadAppRuntime(appName, snapshot)
        this.markState('running')
      } catch (error) {
        this.markState('failed', normalizeError(error))
        this.logger.error(
          new Error(`Failed to reload Neem app [${appName}]`, { cause: error }),
        )
        throw error
      }
    })
  }

  reloadPlugin(
    instanceId: number,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.markState('reloading')
      this.snapshot = snapshot
      this.logger = createNeemChildLogger(snapshot.logger, 'Neem server')

      try {
        await this.reloadPluginRuntime(instanceId, snapshot)
        this.markState('running')
      } catch (error) {
        this.markState('failed', normalizeError(error))
        this.logger.error(
          new Error(`Failed to reload Neem plugin [${instanceId}]`, {
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
        this.markState('stopped')
        this.logLifecycle('Neem server stopped')
      }
    })
  }

  protected async startRuntime(snapshot: NeemRuntimeSnapshot): Promise<void> {
    const { NeemPluginManager } = await import('./plugin.ts')
    const { NeemProxyManager } = await import('./proxy.ts')
    const pluginManager = new NeemPluginManager({
      snapshot,
      hooks: this.hooks,
      onWorkerFailure: (error) => {
        this.markState('failed', error)
        void this.options.onFailure?.(error)
      },
    })
    const appManager = new NeemAppManager({
      snapshot,
      proxyUpstreams: this.proxyUpstreams,
      hooks: this.hooks,
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
      await pluginManager.start()
      await this.callHook('server:start')
      await appManager.start()
      await proxyManager?.start()
      this.pluginManager = pluginManager
      this.appManager = appManager
      this.proxyManager = proxyManager
    } catch (error) {
      await proxyManager?.stop().catch(() => undefined)
      await appManager.stop().catch(() => undefined)
      await pluginManager.stop().catch(() => undefined)
      throw error
    }
  }

  protected async stopRuntime(_snapshot: NeemRuntimeSnapshot): Promise<void> {
    const proxyManager = this.proxyManager
    const appManager = this.appManager
    const pluginManager = this.pluginManager
    this.proxyManager = undefined
    this.appManager = undefined
    this.pluginManager = undefined
    await proxyManager?.stop()
    await appManager?.stop()
    await pluginManager?.stop()
  }

  protected async reloadAppRuntime(
    appName: string,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    if (!this.appManager) {
      throw new Error('Cannot reload Neem app before runtime starts')
    }

    await this.appManager.reloadApp(appName, snapshot)
  }

  protected async reloadPluginRuntime(
    instanceId: number,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    if (!this.pluginManager) {
      throw new Error('Cannot reload Neem plugin before runtime starts')
    }

    await this.pluginManager.reloadPlugin(instanceId, snapshot)
  }

  private markState(state: NeemApplicationServerState, error?: Error): void {
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
    this.operation = this.operation.then(task, task)
    return this.operation
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
