import type { UserConfig } from 'vite'

export type PluginBuildEntrypoint = {
  id: string
  source: string
  target: 'worker' | 'server' | 'cli'
  vite?: UserConfig
}

export interface NeemServerPluginContext {
  mode: 'development' | 'production'
}

export interface NeemServerPluginHooks {
  'server:setup'?: (ctx: NeemServerPluginContext) => Promise<void> | void
  'server:start'?: (ctx: NeemServerPluginContext) => Promise<void> | void
  'server:stop'?: (ctx: NeemServerPluginContext) => Promise<void> | void
  'server:dispose'?: (ctx: NeemServerPluginContext) => Promise<void> | void
  'build:entrypoints'?: (
    ctx: NeemServerPluginContext,
  ) => Promise<PluginBuildEntrypoint[]> | PluginBuildEntrypoint[]
}

export interface NeemServerPlugin {
  name: string
  hooks?: NeemServerPluginHooks
}

export function createPlugin<T extends NeemServerPlugin>(plugin: T): T {
  return plugin
}
