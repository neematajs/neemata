import type { NeemMode } from '../../public/index.ts'
import type { NeemStartedAppWorker, NeemStartedAppWorkerPool } from './app.ts'
import type { NeemPluginManager, NeemStartedPlugin } from './plugin.ts'
import type { NeemProxyUpstreamSnapshot } from './proxy.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { NeemAppManager } from './app.ts'
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
  private operation = Promise.resolve()
  private pluginManager: NeemPluginManager | undefined
  private appManager: NeemAppManager | undefined
  private proxyUpstreams = new NeemProxyUpstreamRegistry()

  constructor(readonly options: NeemApplicationServerOptions) {
    this.snapshot = options.snapshot
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
        await this.startRuntime(this.snapshot)
        this.markState('running')
      } catch (error) {
        this.markState('failed', normalizeError(error))
        throw error
      }
    })
  }

  reload(snapshot: NeemRuntimeSnapshot): Promise<void> {
    return this.enqueue(async () => {
      this.markState('reloading')
      try {
        await this.stopRuntime(this.snapshot)
        this.snapshot = snapshot
        await this.startRuntime(this.snapshot)
        this.markState('running')
      } catch (error) {
        this.markState('failed', normalizeError(error))
        throw error
      }
    })
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this.state === 'stopped') return
      this.markState('stopping')
      try {
        await this.stopRuntime(this.snapshot)
      } finally {
        this.markState('stopped')
      }
    })
  }

  protected async startRuntime(snapshot: NeemRuntimeSnapshot): Promise<void> {
    const { NeemPluginManager } = await import('./plugin.ts')
    const pluginManager = new NeemPluginManager({
      snapshot,
      onWorkerFailure: (error) => {
        this.markState('failed', error)
        void this.options.onFailure?.(error)
      },
    })
    const appManager = new NeemAppManager({
      snapshot,
      proxyUpstreams: this.proxyUpstreams,
      onWorkerFailure: (error) => {
        if (this.options.failOnWorkerError) {
          this.markState('failed', error)
          void this.options.onFailure?.(error)
        }
      },
    })

    try {
      await pluginManager.start()
      await appManager.start()
      this.pluginManager = pluginManager
      this.appManager = appManager
    } catch (error) {
      await appManager.stop().catch(() => undefined)
      await pluginManager.stop().catch(() => undefined)
      throw error
    }
  }

  protected async stopRuntime(_snapshot: NeemRuntimeSnapshot): Promise<void> {
    const appManager = this.appManager
    const pluginManager = this.pluginManager
    this.appManager = undefined
    this.pluginManager = undefined
    await appManager?.stop()
    await pluginManager?.stop()
  }

  private markState(state: NeemApplicationServerState, error?: Error): void {
    this.revision += 1
    this.state = state
    this.lastError = error
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.operation = this.operation.then(task, task)
    return this.operation
  }
}
