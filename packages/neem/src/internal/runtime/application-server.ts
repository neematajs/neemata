import type { NeemMode } from '../../public/index.ts'
import type { NeemPluginManager } from './plugin.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { normalizeError } from './utils.ts'

export type NeemApplicationServerOptions = { snapshot: NeemRuntimeSnapshot }

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
      },
    })
    await pluginManager.start()
    this.pluginManager = pluginManager
  }

  protected async stopRuntime(_snapshot: NeemRuntimeSnapshot): Promise<void> {
    const pluginManager = this.pluginManager
    this.pluginManager = undefined
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
