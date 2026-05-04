import type { InferNeemThreadOptions, NeemApp } from './app.ts'
import type { NeemRolldownOptions } from './artifact.ts'
import type { InferNeemPluginOptions, NeemPlugin } from './plugin.ts'

export type NeemEntryModule<T> = { default: T }

export type NeemEntryLoader<T> = () => Promise<NeemEntryModule<T>>

export type InferNeemEntryDefault<TEntry> = TEntry extends () => Promise<
  infer TModule
>
  ? TModule extends { default: infer TDefault }
    ? TDefault
    : never
  : never

export type NeemBuildConfig = NeemRolldownOptions

export type NeemBuildConfigLoader<
  TBuildConfig extends NeemBuildConfig = NeemBuildConfig,
> = () => Promise<NeemEntryModule<TBuildConfig>>

export type NeemBuildConfigInput<
  TBuildConfig extends NeemBuildConfig = NeemBuildConfig,
> = TBuildConfig | NeemBuildConfigLoader<TBuildConfig>

export type NeemAppConfig<TApp extends NeemApp<any, any> = NeemApp<any, any>> =
  {
    entry: NeemEntryLoader<TApp>
    build?: NeemBuildConfigInput
    threads: Array<InferNeemThreadOptions<TApp>>
  }

export type NeemAppOptions<TApp extends NeemApp<any, any> = NeemApp<any, any>> =
  NeemAppConfig<TApp>

export type NeemPluginOptions<TPlugin = NeemPlugin> = {
  entry: NeemEntryLoader<TPlugin>
  build?: NeemBuildConfigInput
  options?: InferNeemPluginOptions<TPlugin>
}

export type NeemConfig = {
  apps: Record<string, NeemAppConfig<any>>
  plugins?: readonly NeemPluginOptions<any>[]
  outDir?: string
}

export function defineConfig(config: {
  apps: Record<string, NeemAppConfig<any>>
  plugins?: readonly NeemPluginOptions<any>[]
  outDir?: string
}): NeemConfig {
  return Object.freeze(config)
}

export function defineAppConfig<App extends NeemApp<any, any>>(config: {
  entry: NeemEntryLoader<App>
  build?: NeemBuildConfigInput
  threads: Array<InferNeemThreadOptions<App>>
}): NeemAppConfig<App> {
  return Object.freeze(config) as any
}

export function definePluginConfig<Plugin extends NeemPlugin<any>>(config: {
  entry: NeemEntryLoader<Plugin>
  build?: NeemBuildConfigInput
  options?: InferNeemPluginOptions<Plugin>
}): NeemPluginOptions<Plugin> {
  return Object.freeze(config) as any
}
