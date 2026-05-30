import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'
import type { Hookable, HookCallback } from 'hookable'
import { createHooks } from 'hookable'

import type {
  NeemHostHookEvent,
  NeemHostHookMap,
  NeemHostRuntimeHookEvent,
  NeemHostWorkerHookEvent,
} from '../../public/hooks.ts'
import { childLogger } from '../shared/logger.ts'
import { normalizeError } from '../shared/utils.ts'

export type HostHookMap = NeemHostHookMap & {
  'host:initialize': (event: NeemHostHookEvent) => MaybePromise<void>
  'host:dispose': (event: NeemHostHookEvent) => MaybePromise<void>
}

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
          'Calling Neem host hook callbacks',
        )
      }
      for (const callback of callbacks) {
        await callHookCallback(callback, callbackArgs, hookName, hookLogger)
      }
    },
    name,
    args,
  )
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
