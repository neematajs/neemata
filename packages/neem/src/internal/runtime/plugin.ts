import type { NeemArtifactRegistry } from '../../public/artifact.ts'
import type { NeemPlugin, NeemPluginContext } from '../../public/plugin.ts'
import type { NeemMode } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemHostHooks } from './hooks.ts'
import type { NeemPluginWorkerManagerHealth } from './plugin-manager.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import {
  callNeemHostHook,
  clearNeemPluginHooks,
  createNeemPluginHookRegistrar,
} from './hooks.ts'
import { createNeemChildLogger } from './logger.ts'
import { NeemPluginWorkerManager } from './plugin-manager.ts'
import { importDefault } from './utils.ts'

export type NeemStartedPlugin = {
  name: string
  instanceId: number
  workers: NeemPluginWorkerManager
  getState: () => NeemStartedPluginState
  getHealth: () => NeemStartedPluginHealth
  stop: () => Promise<void>
}

export type NeemStartedPluginState =
  | 'idle'
  | 'setting-up'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type NeemStartedPluginHealth = {
  name: string
  instanceId: number
  state: NeemStartedPluginState
  setupComplete: boolean
  workers: NeemPluginWorkerManagerHealth
  lastError?: Error
}

export type NeemPluginManagerOptions = {
  snapshot: NeemRuntimeSnapshot
  hooks: NeemHostHooks
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
      runtimeWorkerEntry: snapshot.runtimeWorkerEntry,
      hooks: this.options.hooks,
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
  runtimeWorkerEntry?: string | URL
  hooks: NeemHostHooks
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
  private state: NeemStartedPluginState = 'idle'
  private lastError: Error | undefined
  private readonly hookUnregisters = new Set<() => void>()

  constructor(private readonly options: NeemStartedPluginRuntimeOptions) {
    this.name = options.name
    this.instanceId = options.instanceId
    this.workers = new NeemPluginWorkerManager({
      mode: options.mode,
      name: options.name,
      instanceId: options.instanceId,
      artifacts: options.workerArtifacts,
      configFile: options.configFile,
      runtimeWorkerEntry: options.runtimeWorkerEntry,
      hooks: options.hooks,
      logger: options.logger,
      startupTimeoutMs: options.startupTimeoutMs,
      stopTimeoutMs: options.stopTimeoutMs,
      onFailure: (error) => {
        this.markFailed(error)
        return options.onWorkerFailure?.(error, this)
      },
    })
  }

  getState(): NeemStartedPluginState {
    return this.state
  }

  getHealth(): NeemStartedPluginHealth {
    return {
      name: this.name,
      instanceId: this.instanceId,
      state: this.state,
      setupComplete: this.setupComplete,
      workers: this.workers.getHealth(),
      lastError: this.lastError,
    }
  }

  async setup(): Promise<void> {
    if (this.setupComplete) return
    this.state = 'setting-up'
    this.lastError = undefined
    this.options.logger.debug(
      { plugin: this.name, instanceId: this.instanceId },
      'Setting up Neem plugin',
    )
    await this.callPluginHook('plugin:setup')
    try {
      await this.options.plugin.setup?.(this.createContext())
      this.setupComplete = true
      this.options.logger.debug(
        { plugin: this.name, instanceId: this.instanceId },
        'Neem plugin setup complete',
      )
      this.state = 'ready'
      await this.callPluginHook('plugin:ready')
    } catch (error) {
      const normalized = normalizeUnknownError(error)
      this.markFailed(normalized)
      await this.callPluginHook('plugin:fail', normalized)
      throw error
    }
  }

  async stop(): Promise<void> {
    let stopError: Error | undefined
    let thrownError: unknown
    this.state = 'stopping'
    try {
      if (this.setupComplete) {
        this.options.logger.debug(
          { plugin: this.name, instanceId: this.instanceId },
          'Stopping Neem plugin',
        )
        try {
          await this.options.plugin.stop?.(this.createContext())
        } catch (error) {
          stopError = normalizeUnknownError(error)
          this.markFailed(stopError)
          await this.callPluginHook('plugin:fail', stopError)
          thrownError = error
        }
      }
    } finally {
      try {
        if (this.workers.list().length > 0) await this.workers.stopAll()
      } catch (error) {
        stopError ??= normalizeUnknownError(error)
        this.markFailed(stopError)
        await this.callPluginHook('plugin:fail', stopError)
        thrownError ??= error
      } finally {
        this.setupComplete = false
        this.options.logger.debug(
          { plugin: this.name, instanceId: this.instanceId },
          'Neem plugin stopped',
        )
        if (!stopError) {
          this.state = 'stopped'
          this.lastError = undefined
          await this.callPluginHook('plugin:stop')
        }
        clearNeemPluginHooks(this.hookUnregisters)
      }
    }
    if (thrownError) throw thrownError
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
      hooks: createNeemPluginHookRegistrar(
        this.options.hooks,
        this.hookUnregisters,
      ),
    }
  }

  private callPluginHook(
    name: 'plugin:setup' | 'plugin:ready' | 'plugin:stop',
  ): Promise<void>
  private callPluginHook(name: 'plugin:fail', error: Error): Promise<void>
  private callPluginHook(
    name: 'plugin:setup' | 'plugin:ready' | 'plugin:stop' | 'plugin:fail',
    error?: Error,
  ): Promise<void> {
    return callNeemHostHook(this.options.hooks, this.options.logger, name, {
      mode: this.options.mode,
      name: this.name,
      instanceId: this.instanceId,
      error,
    })
  }

  private markFailed(error: Error): void {
    this.state = 'failed'
    this.lastError = error
  }
}

function normalizeUnknownError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
