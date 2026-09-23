import type { Hookable } from 'hookable'
import type { Logger } from 'pino'
import { createHooks } from 'hookable'

import type {
  NeemHostHookEvent,
  NeemHostHookMap,
  NeemHostRuntimeHookEvent,
  NeemHostWorkerHookEvent,
} from '../../shared/types.ts'
import { childLogger } from '../logger.ts'
import { normalizeError, throwCollected } from '../utils.ts'

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

/**
 * Runs every callback of a hook in registration order. One that fails does
 * not skip the rest: a later plugin's `dispose` still releases its resources.
 * Rejects with every failure once all have run.
 */
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
      const errors: Error[] = []
      for (const callback of callbacks) {
        try {
          await callback(...callbackArgs)
        } catch (error) {
          errors.push(normalizeError(error))
        }
      }
      throwCollected(errors, `Neem hook [${hookName}] failed`)
    },
    name,
    args,
  )
}
