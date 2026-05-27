import type { LoggingOptions } from '@nmtjs/core'
import type { CommandDef } from 'citty'

import type {
  NeemArtifactEntry,
  NeemRolldownOptions,
  NeemRuntimeBuildHost,
} from './artifact.ts'
import type { NeemRuntimeHostFactory } from './runtime.ts'
import type { InferNeemWorkerData, NeemWorker } from './worker.ts'

export type NeemEntryModule<T> = { default: T }

export type NeemEntryLoader<T> = () => Promise<NeemEntryModule<T>>

export type NeemEntryInput = NeemArtifactEntry

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
> = NeemArtifactEntry

export type NeemRuntimeBuildOptions = { rolldown?: NeemRolldownOptions }

export type NeemRuntimeBuildConfig = NeemRuntimeBuildOptions & {
  config?: NeemBuildConfigInput
  host?: NeemRuntimeBuildHost
  artifacts?: readonly {
    id: string
    kind: 'worker' | 'module'
    entry: NeemArtifactEntry
    rolldown?: NeemRolldownOptions
  }[]
}

export type NeemRuntimeBuildInput =
  | NeemBuildConfigInput
  | NeemRuntimeBuildConfig

export type NeemLoggerOptions = LoggingOptions

export type NeemLoggerInput = NeemLoggerOptions | string | URL

export type NeemCommand = CommandDef

export type NeemCommandInput<TCommand extends NeemCommand = NeemCommand> =
  NeemArtifactEntry

export type NeemRuntimeHostConfig<
  THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = { entry: NeemArtifactEntry; build?: NeemBuildConfigInput }

export type NeemRuntimeHostInput<
  THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = NeemArtifactEntry | NeemRuntimeHostConfig<THost>

export type NeemRuntimeConfig<
  TEntry = NeemWorker<unknown, unknown>,
  THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = {
  entry: NeemEntryInput
  host?: NeemRuntimeHostInput<THost>
  build?: NeemRuntimeBuildInput
  threads?: number | readonly InferNeemRuntimeThreadOptions<TEntry>[]
  options?: unknown
}

export type NeemRuntimeConfigBase = {
  entry: NeemEntryInput
  host?: NeemRuntimeHostInput
  build?: NeemRuntimeBuildInput
  threads?: number | readonly unknown[]
  options?: unknown
}

export type NeemRuntimeConfigInput =
  | NeemRuntimeConfigBase
  | readonly [NeemRuntimeConfigBase, NeemRuntimeBuildOptions]

export type NeemRuntimeConfigEntries = Record<string, NeemRuntimeConfigInput>

export type NeemNormalizedRuntimeConfigEntries<
  TRuntimes extends NeemRuntimeConfigEntries,
> = {
  readonly [K in keyof TRuntimes]: NeemRuntimeConfigBase
}

export type InferNeemRuntimeThreadOptions<TEntry> = TEntry extends {
  _: { data: unknown }
}
  ? InferNeemWorkerData<TEntry>
  : unknown

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

export type NeemHealthConfig = {
  hostname?: string
  port: number
  paths?: { health?: string; ready?: string }
}

export type NeemConfig<
  TRuntimes extends NeemRuntimeConfigEntries = Record<
    string,
    NeemRuntimeConfigInput
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
  health?: NeemHealthConfig
  commands?: Record<string, NeemCommandInput>
  outDir?: string
}

export type NeemNormalizedConfig = NeemConfig<
  Record<string, NeemRuntimeConfigBase>
>

export function defineConfig<
  const TRuntimes extends NeemRuntimeConfigEntries,
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
  health?: NeemHealthConfig
  commands?: Record<string, NeemCommandInput>
  outDir?: string
}): NeemConfig<TRuntimes> {
  return Object.freeze(config)
}

export function defineRuntime<
  Entry,
  Host extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
>(config: {
  entry: NeemEntryInput
  host?: NeemRuntimeHostInput<Host>
  build?: NeemRuntimeBuildInput
  threads?: number | readonly InferNeemRuntimeThreadOptions<Entry>[]
  options?: unknown
}): NeemRuntimeConfig<Entry, Host> {
  return Object.freeze(config) as NeemRuntimeConfig<Entry, Host>
}

export function normalizeNeemConfig<
  const TRuntimes extends NeemRuntimeConfigEntries,
>(
  config: NeemConfig<TRuntimes>,
): NeemConfig<NeemNormalizedRuntimeConfigEntries<TRuntimes>> {
  return Object.freeze({
    ...config,
    runtimes: normalizeNeemRuntimeConfigEntries(config.runtimes),
  })
}

export function normalizeNeemRuntimeConfigEntries<
  const TRuntimes extends NeemRuntimeConfigEntries,
>(runtimes: TRuntimes): NeemNormalizedRuntimeConfigEntries<TRuntimes> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(runtimes).map(([name, input]) => [
        name,
        normalizeNeemRuntimeConfig(input),
      ]),
    ),
  ) as NeemNormalizedRuntimeConfigEntries<TRuntimes>
}

export function normalizeNeemRuntimeConfig(
  input: NeemRuntimeConfigInput,
): NeemRuntimeConfigBase {
  if (!isRuntimeConfigTuple(input)) return input
  const [runtime, build] = input

  return Object.freeze({
    ...runtime,
    build: mergeNeemRuntimeBuildOptions(runtime.build, build),
  })
}

function isRuntimeConfigTuple(
  input: NeemRuntimeConfigInput,
): input is readonly [NeemRuntimeConfigBase, NeemRuntimeBuildOptions] {
  return Array.isArray(input)
}

function mergeNeemRuntimeBuildOptions(
  base: NeemRuntimeBuildInput | undefined,
  override: NeemRuntimeBuildOptions | undefined,
): NeemRuntimeBuildInput | undefined {
  if (!base) return override
  if (!override) return base
  const baseConfig = normalizeRuntimeBuildInput(base)
  if (!baseConfig) return override
  const normalizedBase = baseConfig

  return {
    ...normalizedBase,
    ...override,
    rolldown: mergeRolldownOptions(normalizedBase.rolldown, override.rolldown),
  }
}

function normalizeRuntimeBuildInput(
  input: NeemRuntimeBuildInput | undefined,
): NeemRuntimeBuildConfig | undefined {
  if (!input) return undefined
  return typeof input === 'string' || input instanceof URL
    ? { config: input }
    : input
}

function mergeRolldownOptions(
  base: NeemRolldownOptions | undefined,
  override: NeemRolldownOptions | undefined,
): NeemRolldownOptions | undefined {
  if (!base) return override
  if (!override) return base

  const plugins = [
    ...normalizeRolldownPlugins(base.plugins),
    ...normalizeRolldownPlugins(override.plugins),
  ]

  return {
    ...base,
    ...override,
    plugins: plugins.length > 0 ? plugins : undefined,
  }
}

function normalizeRolldownPlugins(
  plugins: NeemRolldownOptions['plugins'] | undefined,
): NonNullable<NeemRolldownOptions['plugins']>[] {
  if (!plugins) return []
  return (Array.isArray(plugins) ? plugins : [plugins]).filter(
    (plugin): plugin is NonNullable<typeof plugin> => plugin !== undefined,
  )
}
