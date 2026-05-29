import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Logger } from '@nmtjs/core'

import type {
  NeemHostHooks,
  NeemPluginHooksFactory,
} from '../../public/hooks.ts'
import type { NeemMode, NeemRuntimeServerHealth } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'

export type NeemPluginHookRegistration = { remove: () => void }

export async function registerManifestPluginHooks(options: {
  manifest: NeemBuildManifest
  outDir: string
  mode: NeemMode
  logger: Logger
  hooks: NeemHostHooks
  getHealth: () => NeemRuntimeServerHealth
  cacheBust?: boolean
}): Promise<NeemPluginHookRegistration[]> {
  const registrations: NeemPluginHookRegistration[] = []

  for (const plugin of options.manifest.plugins ?? []) {
    if (!plugin.entry) continue

    const entryUrl = pathToFileURL(resolve(options.outDir, plugin.entry.file))
    const moduleUrl = options.cacheBust
      ? `${entryUrl.href}?t=${Date.now()}`
      : entryUrl.href
    const module = (await import(moduleUrl)) as {
      default?: NeemPluginHooksFactory
    }
    const factory = module.default
    if (typeof factory !== 'function') {
      throw new Error(
        `Neem plugin [${plugin.name}] entry must default-export a hooks factory`,
      )
    }

    const pluginHooks = await factory({
      name: plugin.name,
      mode: options.mode,
      options: plugin.options,
      logger: options.logger,
      getHealth: options.getHealth,
    })
    const remove = options.hooks.addHooks(pluginHooks)
    registrations.push({ remove })
  }

  return registrations
}
