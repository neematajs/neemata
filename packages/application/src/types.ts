import type { Container } from '@nmtjs/core'
import type { Transport, TransportPlugin } from '@nmtjs/protocol/server'

import type { Application } from './application.ts'
import type { ApplicationType, LifecycleHook } from './enums.ts'
import type { ApplicationPlugin, ApplicationPluginType } from './plugins.ts'

export type ApplicationWorkerOptions = {
  isServer: boolean
  workerType: ApplicationType
  id: number
  workerOptions: any
}

export interface LifecycleHookTypes
  extends Record<LifecycleHook, (...args: any[]) => unknown> {
  [LifecycleHook.InitializeBefore]: (app: Application) => any
  [LifecycleHook.InitializeAfter]: (app: Application) => any
  [LifecycleHook.StartBefore]: (app: Application) => any
  [LifecycleHook.StartAfter]: (app: Application) => any
  [LifecycleHook.StopBefore]: (app: Application) => any
  [LifecycleHook.StopAfter]: (app: Application) => any
  [LifecycleHook.DisposeBefore]: (app: Application) => any
  [LifecycleHook.DisposeAfter]: (app: Application) => any

  [LifecycleHook.PluginInitializeBefore]: (
    plugin: ApplicationPlugin,
    app: Application,
  ) => any
  [LifecycleHook.PluginInitializeAfter]: (
    plugin: ApplicationPlugin,
    instance: ApplicationPluginType,
    app: Application,
  ) => any
  [LifecycleHook.PluginDisposeBefore]: (
    plugin: ApplicationPlugin,
    instance: ApplicationPluginType,
    app: Application,
  ) => any
  [LifecycleHook.PluginDisposeAfter]: (
    plugin: ApplicationPlugin,
    instance: ApplicationPluginType,
    app: Application,
  ) => any

  [LifecycleHook.TransportInitializeBefore]: (
    transport: TransportPlugin,
    app: Application,
  ) => any
  [LifecycleHook.TransportInitializeAfter]: (
    transport: TransportPlugin,
    instance: Transport,
    app: Application,
  ) => any

  [LifecycleHook.ContainerInitializeBefore]: (
    container: Container,
    app: Application,
  ) => any
  [LifecycleHook.ContainerInitializeAfter]: (
    container: Container,
    app: Application,
  ) => any
  [LifecycleHook.ContainerDisposeBefore]: (
    container: Container,
    app: Application,
  ) => any
  [LifecycleHook.ContainerDisposeAfter]: (
    container: Container,
    app: Application,
  ) => any
}

export type ExtractOptionsPluginsRouters<
  Plugins extends Array<{ plugin: ApplicationPlugin }>,
> = Plugins extends [
  infer First extends { plugin: ApplicationPlugin },
  ...infer Rest extends { plugin: ApplicationPlugin }[],
]
  ? First['plugin'] extends ApplicationPlugin<any, infer AnyRouter>
    ? AnyRouter extends undefined
      ? ExtractOptionsPluginsRouters<Rest>
      : [AnyRouter, ...ExtractOptionsPluginsRouters<Rest>]
    : []
  : []
