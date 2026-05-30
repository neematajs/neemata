import { resolve } from 'node:path'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'

import type { NeemMode, NeemRuntimeServerHealth } from '../../public/runtime.ts'
import type { Manifest } from '../manifest/manifest.ts'
import type { HostHooks, PluginHooks } from './hooks.ts'
import { childLogger } from '../shared/logger.ts'
import { importDefault } from '../shared/utils.ts'
import { callHostHook } from './hooks.ts'

export type PluginContext<Options = unknown> = {
  name: string
  mode: NeemMode
  options: Options
  logger: Logger
  getHealth: () => NeemRuntimeServerHealth
}

export type PluginFactory<Options = unknown> = (
  ctx: PluginContext<Options>,
) => MaybePromise<PluginHooks>

export type PluginEnvironmentOptions = {
  manifest: Manifest
  outDir: string
  mode: NeemMode
  logger: Logger
  hooks: HostHooks
  getHealth: () => NeemRuntimeServerHealth
  cacheBust?: boolean
}

export class PluginEnvironment {
  private removers: Array<() => void> = []
  private initialized = false
  private readonly logger: Logger

  constructor(private readonly options: PluginEnvironmentOptions) {
    this.logger = childLogger(options.logger, 'neem:plugins')
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    const pluginNames =
      this.options.manifest.plugins?.map((plugin) => plugin.name) ?? []
    const logInitialize =
      pluginNames.length > 0
        ? this.logger.debug.bind(this.logger)
        : this.logger.trace.bind(this.logger)
    logInitialize({ plugins: pluginNames }, 'Initializing Neem plugins')

    const hooks = await this.loadHooks()
    const removers: Array<() => void> = []

    try {
      for (const pluginHooks of hooks)
        removers.push(this.options.hooks.addHooks(pluginHooks))

      this.removers = removers
      await callHostHook(
        this.options.hooks,
        this.options.logger,
        'host:initialize',
        { mode: this.options.mode },
      )
      this.initialized = true
      logInitialize({ plugins: pluginNames }, 'Neem plugins initialized')
    } catch (error) {
      for (const remove of removers.reverse()) remove()
      this.removers = []
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (!this.initialized && this.removers.length === 0) return

    this.logger.debug('Disposing Neem plugins')
    try {
      await callHostHook(
        this.options.hooks,
        this.options.logger,
        'host:dispose',
        { mode: this.options.mode },
      )
    } finally {
      for (const remove of this.removers.splice(0).reverse()) remove()
      this.initialized = false
      this.logger.debug('Neem plugins disposed')
    }
  }

  private async loadHooks(): Promise<PluginHooks[]> {
    const hooks: PluginHooks[] = []

    for (const plugin of this.options.manifest.plugins ?? []) {
      if (!plugin.entry) continue

      this.logger.trace({ plugin: plugin.name }, 'Loading Neem plugin')
      const factory = await importDefault<PluginFactory>(
        resolve(this.options.outDir, plugin.entry.file),
        { cacheBust: this.options.cacheBust },
      )
      if (typeof factory !== 'function') {
        throw new Error(
          `Neem plugin [${plugin.name}] entry must default-export a plugin factory`,
        )
      }

      const result = await factory({
        name: plugin.name,
        mode: this.options.mode,
        options: plugin.options,
        logger: this.options.logger,
        getHealth: this.options.getHealth,
      })
      this.logger.trace({ plugin: plugin.name }, 'Neem plugin loaded')
      hooks.push(result)
    }

    return hooks
  }
}
