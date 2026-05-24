import type { Logger, LoggingOptions } from '@nmtjs/core'

import type { NeemArtifact, NeemRolldownOptions } from './artifact.ts'
import type { NeemMaybePromise, NeemMode, NeemRuntimeHost } from './runtime.ts'
import type { InferNeemWorkerData, NeemWorker } from './worker.ts'

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
> = NeemBuildConfigLoader<TBuildConfig>

export type NeemLoggerOptions = LoggingOptions

export type NeemLoggerLoader<TLogger extends Logger = Logger> = () => Promise<
  NeemEntryModule<TLogger>
>

export type NeemLoggerInput<TLogger extends Logger = Logger> =
  | NeemLoggerOptions
  | string
  | URL
  | TLogger
  | NeemLoggerLoader<TLogger>

export type NeemRuntimeHostConfig<
  THost extends NeemRuntimeHost = NeemRuntimeHost,
> = { entry: NeemEntryLoader<THost>; build?: NeemBuildConfigInput }

export type NeemRuntimeHostInput<
  THost extends NeemRuntimeHost = NeemRuntimeHost,
> = NeemEntryLoader<THost> | NeemRuntimeHostConfig<THost>

export type NeemRuntimeConfig<
  TEntry = NeemWorker<unknown, unknown>,
  THost extends NeemRuntimeHost = NeemRuntimeHost,
> = {
  entry: NeemEntryLoader<TEntry>
  host?: NeemRuntimeHostInput<THost>
  build?: NeemBuildConfigInput
  artifacts?: (
    ctx: NeemRuntimeArtifactContext,
  ) => NeemMaybePromise<readonly NeemArtifact[]>
  threads?: number | readonly InferNeemRuntimeThreadOptions<TEntry>[]
  options?: unknown
}

export type NeemRuntimeConfigBase = {
  entry: NeemEntryLoader<unknown>
  host?: NeemRuntimeHostInput
  build?: NeemBuildConfigInput
  artifacts?: (
    ctx: NeemRuntimeArtifactContext,
  ) => NeemMaybePromise<readonly NeemArtifact[]>
  threads?: number | readonly unknown[]
  options?: unknown
}

export type InferNeemRuntimeThreadOptions<TEntry> = TEntry extends {
  _: { data: unknown }
}
  ? InferNeemWorkerData<TEntry>
  : unknown

export type NeemRuntimeArtifactContext<Options = unknown> = {
  mode: NeemMode
  name: string
  options: Options
}

export type NeemProxyRoutingOptions = {
  type?: 'subdomain' | 'path'
  name?: string
  default?: boolean
}

export type NeemProxyConfig = {
  hostname: string
  port: number
  runtimes?: Record<
    string,
    { routing?: NeemProxyRoutingOptions; sni?: string } | undefined
  >
  healthChecks?: { interval?: number }
  stickySessions?: {
    enabled?: boolean
    cookieName?: string
    headerName?: string
    ttlMs?: number
    maxEntries?: number
  }
  tls?: { key: string; cert: string }
}

export type NeemConfig<
  TRuntimes extends Record<string, NeemRuntimeConfigBase> = Record<
    string,
    NeemRuntimeConfigBase
  >,
> = {
  /**
   * Logger configuration for Neem host/runtime logs.
   *
   * Use a plain options object for simple JSON-compatible settings accepted by
   * @nmtjs/core createLogger. Neem can serialize these settings into build
   * metadata and create the default logger at runtime.
   *
   * Use a string or URL module specifier when logging setup needs runtime logic,
   * custom transports, streams, env-sensitive setup, or non-serializable values.
   * The module must default-export an @nmtjs/core Logger.
   *
   * Do not create logger instances or open runtime resources directly in
   * neem.config.ts; config is build/dev declaration only.
   */
  logger?: NeemLoggerInput
  runtimes: TRuntimes
  proxy?: NeemProxyConfig
  outDir?: string
}

export function defineConfig<
  const TRuntimes extends Record<string, NeemRuntimeConfigBase>,
>(config: {
  /**
   * Logger configuration for Neem host/runtime logs.
   *
   * Use a plain options object for simple JSON-compatible settings accepted by
   * @nmtjs/core createLogger. Use a string or URL module specifier when logging
   * setup needs runtime logic, custom transports, streams, env-sensitive setup,
   * or non-serializable values. The module must default-export an @nmtjs/core
   * Logger.
   *
   * Do not create logger instances or open runtime resources directly in
   * neem.config.ts; config is build/dev declaration only.
   */
  logger?: NeemLoggerInput
  runtimes: TRuntimes
  proxy?: NeemProxyConfig
  outDir?: string
}): NeemConfig<TRuntimes> {
  return Object.freeze(config)
}

export function defineRuntimeConfig<
  Entry,
  Host extends NeemRuntimeHost = NeemRuntimeHost,
>(config: {
  entry: NeemEntryLoader<Entry>
  host?: NeemRuntimeHostInput<Host>
  build?: NeemBuildConfigInput
  artifacts?: (
    ctx: NeemRuntimeArtifactContext,
  ) => NeemMaybePromise<readonly NeemArtifact[]>
  threads?: number | readonly InferNeemRuntimeThreadOptions<Entry>[]
  options?: unknown
}): NeemRuntimeConfig<Entry, Host> {
  return Object.freeze(config) as NeemRuntimeConfig<Entry, Host>
}
