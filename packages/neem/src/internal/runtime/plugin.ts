import type { NeemArtifactRegistry } from '../../public/artifact.ts'
import type { NeemPlugin, NeemPluginContext } from '../../public/plugin.ts'
import type { NeemMode } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import { NeemPluginWorkerManager } from './plugin-manager.ts'
import { importDefault } from './utils.ts'

export type NeemStartedPlugin = {
  name: string
  instanceId: number
  workers: NeemPluginWorkerManager
  stop: () => Promise<void>
}

export type NeemPluginManagerOptions = {
  snapshot: NeemRuntimeSnapshot
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  onWorkerFailure?: (
    error: Error,
    plugin: NeemStartedPlugin,
  ) => void | Promise<void>
}

export class NeemPluginManager {
  private readonly plugins: NeemStartedPluginRuntime[] = []

  constructor(private readonly options: NeemPluginManagerOptions) {}

  list(): readonly NeemStartedPlugin[] {
    return this.plugins
  }

  async start(): Promise<void> {
    if (this.plugins.length > 0) return

    try {
      for (const pluginManifest of this.options.snapshot.manifest.plugins) {
        const plugin = await this.createPlugin(pluginManifest)
        this.plugins.push(plugin)
        await plugin.setup()
      }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    const plugins = this.plugins.splice(0).reverse()
    await Promise.all(plugins.map((plugin) => plugin.stop()))
  }

  private async createPlugin(
    pluginManifest: NeemBuildManifest['plugins'][number],
  ): Promise<NeemStartedPluginRuntime> {
    const plugin = await importDefault<NeemPlugin<any>>(
      this.options.snapshot.artifacts.resolveFor(
        {
          type: 'plugin',
          name: pluginManifest.name,
          instanceId: pluginManifest.index,
        },
        'entry',
      )!.file,
    )

    const options =
      this.options.snapshot.config.plugins?.[pluginManifest.index]?.options

    return new NeemStartedPluginRuntime({
      mode: this.options.snapshot.mode,
      name: pluginManifest.name,
      instanceId: pluginManifest.index,
      options,
      plugin,
      artifacts: this.options.snapshot.artifacts.scope({
        type: 'plugin',
        name: pluginManifest.name,
        instanceId: pluginManifest.index,
      }),
      workerArtifacts: this.options.snapshot.artifacts,
      startupTimeoutMs: this.options.startupTimeoutMs,
      stopTimeoutMs: this.options.stopTimeoutMs,
      onWorkerFailure: (error, startedPlugin) =>
        this.options.onWorkerFailure?.(error, startedPlugin),
    })
  }
}

type NeemStartedPluginRuntimeOptions = {
  mode: NeemMode
  name: string
  instanceId: number
  options: unknown
  plugin: NeemPlugin<any>
  artifacts: NeemArtifactRegistry
  workerArtifacts: NeemRuntimeSnapshot['artifacts']
  startupTimeoutMs?: number
  stopTimeoutMs?: number
  onWorkerFailure?: (
    error: Error,
    plugin: NeemStartedPlugin,
  ) => void | Promise<void>
}

class NeemStartedPluginRuntime implements NeemStartedPlugin {
  readonly name: string
  readonly instanceId: number
  readonly workers: NeemPluginWorkerManager

  private setupComplete = false

  constructor(private readonly options: NeemStartedPluginRuntimeOptions) {
    this.name = options.name
    this.instanceId = options.instanceId
    this.workers = new NeemPluginWorkerManager({
      mode: options.mode,
      name: options.name,
      instanceId: options.instanceId,
      artifacts: options.workerArtifacts,
      startupTimeoutMs: options.startupTimeoutMs,
      stopTimeoutMs: options.stopTimeoutMs,
      onFailure: (error) => options.onWorkerFailure?.(error, this),
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
