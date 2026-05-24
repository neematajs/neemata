import type { Logger } from '@nmtjs/core'
import type { Hookable, HookCallback } from 'hookable'
import { createHooks } from 'hookable'

import type { NeemArtifactOwner } from '../../public/artifact.ts'
import type {
  NeemMaybePromise,
  NeemMode,
  NeemRuntimeUpstream,
} from '../../public/runtime.ts'
import { normalizeError } from './utils.ts'

export type NeemHostHookEvent = { mode: NeemMode; error?: Error }

export type NeemHostRuntimeHookEvent = NeemHostHookEvent & {
  name: string
  upstreams?: readonly NeemRuntimeUpstream[]
}

export type NeemHostWorkerHookEvent = NeemHostHookEvent & {
  id: string
  name: string
  artifactId: string
  owner: NeemArtifactOwner
}

export type NeemHostHookMap = {
  'server:start': (event: NeemHostHookEvent) => NeemMaybePromise<void>
  'server:ready': (event: NeemHostHookEvent) => NeemMaybePromise<void>
  'server:reload': (event: NeemHostHookEvent) => NeemMaybePromise<void>
  'server:stop': (event: NeemHostHookEvent) => NeemMaybePromise<void>
  'server:fail': (event: NeemHostHookEvent) => NeemMaybePromise<void>
  'runtime:start': (event: NeemHostRuntimeHookEvent) => NeemMaybePromise<void>
  'runtime:ready': (event: NeemHostRuntimeHookEvent) => NeemMaybePromise<void>
  'runtime:reload': (event: NeemHostRuntimeHookEvent) => NeemMaybePromise<void>
  'runtime:stop': (event: NeemHostRuntimeHookEvent) => NeemMaybePromise<void>
  'runtime:fail': (event: NeemHostRuntimeHookEvent) => NeemMaybePromise<void>
  'worker:start': (event: NeemHostWorkerHookEvent) => NeemMaybePromise<void>
  'worker:ready': (event: NeemHostWorkerHookEvent) => NeemMaybePromise<void>
  'worker:stop': (event: NeemHostWorkerHookEvent) => NeemMaybePromise<void>
  'worker:fail': (event: NeemHostWorkerHookEvent) => NeemMaybePromise<void>
}

export type NeemHostHooks = Hookable<NeemHostHookMap>

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
