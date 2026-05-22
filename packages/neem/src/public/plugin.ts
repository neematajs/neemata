import type { MessagePort } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'
import type { Hookable } from 'hookable'

import type {
  NeemArtifact,
  NeemArtifactOwner,
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from './artifact.ts'
import type {
  NeemManagedWorkerHandle,
  NeemMaybePromise,
  NeemMode,
} from './runtime.ts'

export type NeemPluginArtifactContext<Options = unknown> = {
  mode: NeemMode
  name: string
  instanceId: number
  options: Options
}

export type NeemPluginWorkerSpawnOptions = {
  id?: string
  name: string
  artifact: string | NeemResolvedArtifact
  workerData?: Record<string, unknown>
}

export type NeemPluginWorkerHandle = NeemManagedWorkerHandle & {
  port: MessagePort
}

export type NeemPluginWorkers = {
  spawn: (
    options: NeemPluginWorkerSpawnOptions,
  ) => Promise<NeemPluginWorkerHandle>
  stop: (workerId: string) => Promise<boolean>
  list: () => readonly NeemPluginWorkerHandle[]
}

export type NeemPluginHostHookEvent = { mode: NeemMode; error?: Error }

export type NeemPluginHostAppHookEvent = NeemPluginHostHookEvent & {
  appName: string
}

export type NeemPluginHostPluginHookEvent = NeemPluginHostHookEvent & {
  name: string
  instanceId: number
}

export type NeemPluginHostWorkerHookEvent = NeemPluginHostHookEvent & {
  id: string
  name: string
  artifactId: string
  owner: NeemArtifactOwner
}

export type NeemPluginHostHooks = {
  'server:start': (event: NeemPluginHostHookEvent) => NeemMaybePromise<void>
  'server:ready': (event: NeemPluginHostHookEvent) => NeemMaybePromise<void>
  'server:reload': (event: NeemPluginHostHookEvent) => NeemMaybePromise<void>
  'server:stop': (event: NeemPluginHostHookEvent) => NeemMaybePromise<void>
  'server:fail': (event: NeemPluginHostHookEvent) => NeemMaybePromise<void>
  'app:start': (event: NeemPluginHostAppHookEvent) => NeemMaybePromise<void>
  'app:ready': (event: NeemPluginHostAppHookEvent) => NeemMaybePromise<void>
  'app:reload': (event: NeemPluginHostAppHookEvent) => NeemMaybePromise<void>
  'app:stop': (event: NeemPluginHostAppHookEvent) => NeemMaybePromise<void>
  'app:fail': (event: NeemPluginHostAppHookEvent) => NeemMaybePromise<void>
  'plugin:setup': (
    event: NeemPluginHostPluginHookEvent,
  ) => NeemMaybePromise<void>
  'plugin:ready': (
    event: NeemPluginHostPluginHookEvent,
  ) => NeemMaybePromise<void>
  'plugin:stop': (
    event: NeemPluginHostPluginHookEvent,
  ) => NeemMaybePromise<void>
  'plugin:fail': (
    event: NeemPluginHostPluginHookEvent,
  ) => NeemMaybePromise<void>
  'worker:start': (
    event: NeemPluginHostWorkerHookEvent,
  ) => NeemMaybePromise<void>
  'worker:ready': (
    event: NeemPluginHostWorkerHookEvent,
  ) => NeemMaybePromise<void>
  'worker:stop': (
    event: NeemPluginHostWorkerHookEvent,
  ) => NeemMaybePromise<void>
  'worker:fail': (
    event: NeemPluginHostWorkerHookEvent,
  ) => NeemMaybePromise<void>
}

export type NeemPluginHostHookRegistrar = Pick<
  Hookable<NeemPluginHostHooks>,
  'addHooks' | 'hook' | 'hookOnce'
>

export type NeemPluginContext<Options = unknown> = {
  mode: NeemMode
  name: string
  instanceId: number
  options: Options
  logger: Logger
  artifacts: NeemArtifactRegistry
  workers: NeemPluginWorkers
  hooks: NeemPluginHostHookRegistrar
}

export type NeemPlugin<Options = unknown> = {
  name: string
  artifacts?: (
    ctx: NeemPluginArtifactContext<Options>,
  ) => NeemMaybePromise<readonly NeemArtifact[]>
  setup?: (ctx: NeemPluginContext<Options>) => NeemMaybePromise<void>
  stop?: (ctx: NeemPluginContext<Options>) => NeemMaybePromise<void>
}

export type InferNeemPluginOptions<TPlugin> =
  TPlugin extends NeemPlugin<infer Options> ? Options : unknown

export function definePlugin<
  Options = unknown,
  const TPlugin extends NeemPlugin<Options> = NeemPlugin<Options>,
>(plugin: TPlugin): TPlugin {
  return Object.freeze(plugin)
}
