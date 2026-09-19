import { resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'

import type {
  NeemMode,
  NeemPluginHooks,
  NeemPluginHooksFactory,
  NeemRuntimeServerHealth,
} from '../../shared/types.ts'
import type { Manifest, ManifestPlugin } from '../manifest/manifest.ts'
import type { HostHooks } from './hooks.ts'
import { childLogger } from '../logger.ts'
import { importDefault, normalizeError } from '../utils.ts'
import { callHostHook } from './hooks.ts'

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
  private readonly removers: Array<() => void> = []
  private readonly logger: Logger
  private readonly hostLogger: Logger
  private readonly hooks: HostHooks
  private readonly mode: NeemMode
  private readonly outDir: string
  private readonly plugins: readonly ManifestPlugin[]
  private readonly getHealth: () => NeemRuntimeServerHealth
  private readonly cacheBust: boolean | undefined
  private initialized = false

  constructor(options: PluginEnvironmentOptions) {
    const { hooks, mode, outDir, getHealth, cacheBust } = options
    this.logger = childLogger(options.logger, 'neem:plugins')
    this.hostLogger = options.logger
    this.hooks = hooks
    this.mode = mode
    this.outDir = outDir
    this.plugins = options.manifest.plugins ?? []
    this.getHealth = getHealth
    this.cacheBust = cacheBust
  }

  async initialize(): Promise<void> {
    if (this.initialized) return

    const names = this.plugins.map((plugin) => plugin.name)
    this.logger.trace({ plugins: names }, 'Initializing Neem plugins')

    const hooks = await this.loadHooks()

    try {
      for (const pluginHooks of hooks) {
        this.removers.push(this.hooks.addHooks(pluginHooks))
      }

      await this.callHook('initialize')
      this.initialized = true
      if (names.length > 0) {
        this.logger.debug({ plugins: names }, 'Neem plugins initialized')
      }
    } catch (error) {
      await this.callHook('dispose').catch((disposeError) => {
        this.logger.warn(
          new Error('Neem plugin initialization cleanup failed', {
            cause: normalizeError(disposeError),
          }),
        )
      })
      this.removeHooks()
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (!this.initialized && this.removers.length === 0) return

    this.logger.debug('Disposing Neem plugins')
    try {
      await this.callHook('dispose')
    } finally {
      this.removeHooks()
      this.initialized = false
      this.logger.debug('Neem plugins disposed')
    }
  }

  private callHook(name: 'initialize' | 'dispose'): Promise<void> {
    return callHostHook(this.hooks, this.hostLogger, name, { mode: this.mode })
  }

  private removeHooks(): void {
    for (const remove of this.removers.splice(0).reverse()) remove()
  }

  private async loadHooks(): Promise<NeemPluginHooks[]> {
    const hooks: NeemPluginHooks[] = []

    for (const plugin of this.plugins) {
      if (!plugin.entry) continue

      this.logger.trace({ plugin: plugin.name }, 'Loading Neem plugin')
      const factory = await importDefault<NeemPluginHooksFactory>(
        resolve(this.outDir, plugin.entry.file),
        { cacheBust: this.cacheBust },
      )
      if (typeof factory !== 'function') {
        throw new Error(
          `Neem plugin [${plugin.name}] entry must default-export a plugin factory`,
        )
      }

      const result = await factory({
        name: plugin.name,
        mode: this.mode,
        options: plugin.options,
        logger: this.hostLogger,
        getHealth: this.getHealth,
      })
      this.logger.trace({ plugin: plugin.name }, 'Neem plugin loaded')
      hooks.push(result)
    }

    return hooks
  }
}
