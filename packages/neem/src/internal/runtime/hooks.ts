import type { Logger } from '@nmtjs/core'
import type { HookCallback } from 'hookable'
import { createHooks } from 'hookable'

import type { NeemHostHookMap, NeemHostHooks } from '../../public/hooks.ts'
import { normalizeError } from './utils.ts'

export type {
  NeemHostHookEvent,
  NeemHostHookMap,
  NeemHostHooks,
  NeemHostRuntimeHookEvent,
  NeemHostWorkerHookEvent,
} from '../../public/hooks.ts'

export function createNeemHostHooks(): NeemHostHooks {
  return createHooks<NeemHostHookMap>()
}

export async function callNeemHostHook<Name extends keyof NeemHostHookMap>(
  hooks: NeemHostHooks,
  logger: Logger,
  name: Name,
  ...args: Parameters<NeemHostHookMap[Name]>
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
