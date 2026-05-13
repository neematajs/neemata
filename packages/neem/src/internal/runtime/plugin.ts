import type { NeemBuildManifest } from '#build/manifest.ts'
import type { NeemArtifactRegistry } from '#public/artifact.ts'
import type { NeemPlugin, NeemPluginContext } from '#public/plugin.ts'
import type { NeemMode } from '#public/runtime.ts'
import { createNeemChildLogger } from '#runtime/logger.ts'
import { NeemPluginWorkerManager } from '#runtime/plugin-manager.ts'
import type { NeemRuntimeSnapshot } from '#runtime/snapshot.ts'
import { importDefault } from '#runtime/utils.ts'

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
  private readonly plugins = new Map<number, NeemStartedPluginRuntime>()

  constructor(private readonly options: NeemPluginManagerOptions) {}

  list(): readonly NeemStartedPlugin[] {
    return [...this.plugins.values()].toSorted(
      (left, right) => left.instanceId - right.instanceId,
    )
  }

  async start(): Promise<void> {
    if (this.plugins.size > 0) return
    if (this.options.snapshot.manifest.plugins.length === 0) return

    try {
      this.options.snapshot.logger.debug(
        { count: this.options.snapshot.manifest.plugins.length },
        'Starting Neem plugins',
      )
      for (const pluginManifest of this.options.snapshot.manifest.plugins) {
        const plugin = await this.createPlugin(
          this.options.snapshot,
          pluginManifest,
        )
        this.plugins.set(plugin.instanceId, plugin)
        await plugin.setup()
      }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    const plugins = this.list().toReversed()
    if (plugins.length === 0) return
    this.plugins.clear()

    this.options.snapshot.logger.debug(
      { count: plugins.length },
      'Stopping Neem plugins',
    )
    await Promise.all(plugins.map((plugin) => plugin.stop()))
  }

  async reloadPlugin(
    instanceId: number,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    const pluginManifest = snapshot.manifest.plugins.find(
      (plugin) => plugin.index === instanceId,
    )

    if (!pluginManifest) {
      await this.removePlugin(instanceId)
      return
    }

    const nextPlugin = await this.createPlugin(snapshot, pluginManifest)
    await this.removePlugin(instanceId)
    this.plugins.set(instanceId, nextPlugin)

    try {
      await nextPlugin.setup()
    } catch (error) {
      this.plugins.delete(instanceId)
      await nextPlugin.stop().catch(() => undefined)
      throw error
    }
  }

  private async createPlugin(
    snapshot: NeemRuntimeSnapshot,
    pluginManifest: NeemBuildManifest['plugins'][number],
  ): Promise<NeemStartedPluginRuntime> {
    const plugin = await importDefault<NeemPlugin<any>>(
      snapshot.artifacts.resolveFor(
        {
          type: 'plugin',
          name: pluginManifest.name,
          instanceId: pluginManifest.index,
        },
        'entry',
      )!.file,
    )

    const options = snapshot.config.plugins?.[pluginManifest.index]?.options

    return new NeemStartedPluginRuntime({
      mode: snapshot.mode,
      name: pluginManifest.name,
      instanceId: pluginManifest.index,
      options,
      plugin,
      artifacts: snapshot.artifacts.scope({
        type: 'plugin',
        name: pluginManifest.name,
        instanceId: pluginManifest.index,
      }),
      workerArtifacts: snapshot.artifacts,
      configFile: snapshot.configFile,
      logger: createNeemChildLogger(
        snapshot.logger,
        `Neem plugin ${pluginManifest.name}:${pluginManifest.index}`,
      ),
      startupTimeoutMs: this.options.startupTimeoutMs,
      stopTimeoutMs: this.options.stopTimeoutMs,
      onWorkerFailure: (error, startedPlugin) =>
        this.options.onWorkerFailure?.(error, startedPlugin),
    })
  }

  private async removePlugin(instanceId: number): Promise<void> {
    const plugin = this.plugins.get(instanceId)
    if (!plugin) return

    this.plugins.delete(instanceId)
    await plugin.stop()
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
  configFile: string
  logger: NeemRuntimeSnapshot['logger']
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
      configFile: options.configFile,
      logger: options.logger,
      startupTimeoutMs: options.startupTimeoutMs,
      stopTimeoutMs: options.stopTimeoutMs,
      onFailure: (error) => options.onWorkerFailure?.(error, this),
    })
  }

  async setup(): Promise<void> {
    if (this.setupComplete) return
    this.options.logger.debug(
      { plugin: this.name, instanceId: this.instanceId },
      'Setting up Neem plugin',
    )
    await this.options.plugin.setup?.(this.createContext())
    this.setupComplete = true
    this.options.logger.debug(
      { plugin: this.name, instanceId: this.instanceId },
      'Neem plugin setup complete',
    )
  }

  async stop(): Promise<void> {
    try {
      if (this.setupComplete) {
        this.options.logger.debug(
          { plugin: this.name, instanceId: this.instanceId },
          'Stopping Neem plugin',
        )
        await this.options.plugin.stop?.(this.createContext())
      }
    } finally {
      if (this.workers.list().length > 0) await this.workers.stopAll()
      this.setupComplete = false
      this.options.logger.debug(
        { plugin: this.name, instanceId: this.instanceId },
        'Neem plugin stopped',
      )
    }
  }

  private createContext(): NeemPluginContext<any> {
    return {
      mode: this.options.mode,
      name: this.options.name,
      instanceId: this.options.instanceId,
      options: this.options.options,
      logger: this.options.logger,
      artifacts: this.options.artifacts,
      workers: this.workers,
    }
  }
}
