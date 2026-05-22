import type { Logger } from '@nmtjs/core'
import type { Hookable, HookCallback } from 'hookable'
import { createHooks } from 'hookable'

import type {
  NeemPluginHostHookRegistrar,
  NeemPluginHostHooks,
} from '../../public/plugin.ts'
import { normalizeError } from './utils.ts'

export type NeemHostHooks = Hookable<NeemPluginHostHooks>

export function createNeemHostHooks(): NeemHostHooks {
  return createHooks<NeemPluginHostHooks>()
}

export function createNeemPluginHookRegistrar(
  hooks: NeemHostHooks,
  unregisters: Set<() => void>,
): NeemPluginHostHookRegistrar {
  return {
    hook(name, callback, options) {
      const unregister = hooks.hook(name, callback, options)
      unregisters.add(unregister)
      return () => {
        unregisters.delete(unregister)
        unregister()
      }
    },
    hookOnce(name, callback) {
      const unregister = hooks.hookOnce(name, callback)
      unregisters.add(unregister)
      return () => {
        unregisters.delete(unregister)
        unregister()
      }
    },
    addHooks(configHooks) {
      const unregister = hooks.addHooks(configHooks)
      unregisters.add(unregister)
      return () => {
        unregisters.delete(unregister)
        unregister()
      }
    },
  }
}

export async function callNeemHostHook<Name extends keyof NeemPluginHostHooks>(
  hooks: NeemHostHooks,
  logger: Logger,
  name: Name,
  ...args: Parameters<NeemPluginHostHooks[Name]>
): Promise<void> {
  await hooks.callHookWith(
    async (callbacks, callbackArgs, hookName) => {
      for (const callback of callbacks) {
        await callHookCallback(callback, callbackArgs, hookName, logger)
      }
    },
    name,
    args,
  )
}

export function clearNeemPluginHooks(unregisters: Set<() => void>): void {
  for (const unregister of unregisters) unregister()
  unregisters.clear()
}

async function callHookCallback(
  callback: HookCallback,
  args: unknown[],
  name: string,
  logger: Logger,
): Promise<void> {
  try {
    await callback(...args)
  } catch (error) {
    logger.warn(
      new Error(`Neem host hook [${name}] failed`, {
        cause: normalizeError(error),
      }),
    )
  }
}
