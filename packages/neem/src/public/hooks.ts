import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'
import type { Hookable } from 'hookable'

import type { NeemArtifactOwner } from './artifact.ts'
import type {
  NeemMode,
  NeemRuntimeServerHealth,
  NeemRuntimeUpstream,
} from './runtime.ts'

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
  'server:start': (event: NeemHostHookEvent) => MaybePromise<void>
  'server:ready': (event: NeemHostHookEvent) => MaybePromise<void>
  'server:reload': (event: NeemHostHookEvent) => MaybePromise<void>
  'server:stop': (event: NeemHostHookEvent) => MaybePromise<void>
  'server:fail': (event: NeemHostHookEvent) => MaybePromise<void>
  'runtime:start': (event: NeemHostRuntimeHookEvent) => MaybePromise<void>
  'runtime:ready': (event: NeemHostRuntimeHookEvent) => MaybePromise<void>
  'runtime:reload': (event: NeemHostRuntimeHookEvent) => MaybePromise<void>
  'runtime:stop': (event: NeemHostRuntimeHookEvent) => MaybePromise<void>
  'runtime:fail': (event: NeemHostRuntimeHookEvent) => MaybePromise<void>
  'worker:start': (event: NeemHostWorkerHookEvent) => MaybePromise<void>
  'worker:ready': (event: NeemHostWorkerHookEvent) => MaybePromise<void>
  'worker:stop': (event: NeemHostWorkerHookEvent) => MaybePromise<void>
  'worker:fail': (event: NeemHostWorkerHookEvent) => MaybePromise<void>
}

export type NeemHostHooks = Hookable<NeemHostHookMap>

export type NeemPluginHooksContext<Options = unknown> = {
  name: string
  mode: NeemMode
  options: Options
  logger: Logger
  getHealth: () => NeemRuntimeServerHealth
}

export type NeemPluginHooksFactory<Options = unknown> = (
  ctx: NeemPluginHooksContext<Options>,
) => MaybePromise<Partial<NeemHostHookMap>>

export function definePluginHooks<const T extends NeemPluginHooksFactory>(
  factory: T,
): T {
  return Object.freeze(factory)
}
