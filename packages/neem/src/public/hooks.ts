import type { Logger } from '@nmtjs/core'
import type { Hookable } from 'hookable'

import type { NeemArtifactOwner } from './artifact.ts'
import type {
  NeemMaybePromise,
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

export type NeemPluginHooksContext<Options = unknown> = {
  name: string
  mode: NeemMode
  options: Options
  logger: Logger
  getHealth: () => NeemRuntimeServerHealth
}

export type NeemPluginHooksFactory<Options = unknown> = (
  ctx: NeemPluginHooksContext<Options>,
) => NeemMaybePromise<Partial<NeemHostHookMap>>

export function definePluginHooks<const T extends NeemPluginHooksFactory>(
  factory: T,
): T {
  return Object.freeze(factory)
}
