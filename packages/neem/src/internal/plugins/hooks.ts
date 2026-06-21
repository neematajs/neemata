import type { Logger } from '@nmtjs/core'
import type { Hookable } from 'hookable'
import { createHooks } from 'hookable'

import type {
  NeemHostHookEvent,
  NeemHostHookMap,
  NeemHostRuntimeHookEvent,
  NeemHostWorkerHookEvent,
} from '../../shared/types.ts'
import { childLogger } from '../logger.ts'

export type HostHookMap = NeemHostHookMap

export type HostHooks = Hookable<HostHookMap>

export type PluginHooks = Partial<HostHookMap>

export type {
  NeemHostHookEvent as HostHookEvent,
  NeemHostRuntimeHookEvent as HostRuntimeHookEvent,
  NeemHostWorkerHookEvent as HostWorkerHookEvent,
}

export function createHostHooks(): HostHooks {
  return createHooks<HostHookMap>()
}

export async function callHostHook<Name extends keyof HostHookMap>(
  hooks: HostHooks,
  logger: Logger,
  name: Name,
  ...args: Parameters<HostHookMap[Name]>
): Promise<void> {
  const hookLogger = childLogger(logger, 'neem:hooks')
  await hooks.callHookWith(
    async (callbacks, callbackArgs, hookName) => {
      if (callbacks.length > 0) {
        hookLogger.trace(
          { hook: hookName, callbacks: callbacks.length },
          'Neem host hook callbacks',
        )
      }
      for (const callback of callbacks) {
        await callback(...callbackArgs)
      }
    },
    name,
    args,
  )
}
