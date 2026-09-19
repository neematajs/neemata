import type { Logger } from '@nmtjs/core'
import { createHooks } from 'hookable'

import type {
  NeemHostHookMap,
  NeemHostHooks,
  NeemPluginHooks,
} from '../../shared/types.ts'
import { childLogger } from '../logger.ts'

export type HostHooks = NeemHostHooks

export type PluginHooks = NeemPluginHooks

export function createHostHooks(): HostHooks {
  return createHooks<NeemHostHookMap>()
}

export async function callHostHook<Name extends keyof NeemHostHookMap>(
  hooks: HostHooks,
  logger: Logger,
  name: Name,
  ...args: Parameters<NeemHostHookMap[Name]>
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
