import type { LoggingOptions } from '@nmtjs/core'
import type { CommandDef } from 'citty'

import type {
  NeemArtifact,
  NeemArtifactEntry,
  NeemRolldownOptions,
} from './artifact.ts'
import type { NeemRuntimeHostFactory } from './runtime.ts'
import type { InferNeemWorkerData, NeemWorker } from './worker.ts'
import { mergeRolldownOptions } from '../internal/build/rolldown-options.ts'

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

export type NeemLoggerOptions = LoggingOptions

export type NeemLoggerInput = NeemLoggerOptions | string | URL

export type NeemCommand = CommandDef

export type NeemCommandInput<TCommand extends NeemCommand = NeemCommand> =
  NeemArtifactEntry

export type NeemPluginBuild = { rolldown?: NeemRolldownOptions }

export type NeemPluginInput = {
  name: string
  entry?: NeemEntryInput
  build?: NeemPluginBuild
  options?: unknown
}

export type NeemRuntimeHostConfig<
  THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = { entry: NeemArtifactEntry; build?: NeemRuntimeBuildConfig }

export type NeemRuntimeWorkerConfig = {
  entry: NeemEntryInput
  build?: NeemRuntimeBuildConfig
}

export type NeemRuntimeBuildConfig = { rolldown?: NeemRolldownOptions }

type NeemRuntimeSharedConfig<TEntry, THost extends NeemRuntimeHostFactory> = {
  host?: NeemRuntimeHostConfig<THost>
  artifacts?: readonly NeemArtifact[]
  threads?: number | readonly InferNeemRuntimeThreadOptions<TEntry>[]
  options?: unknown
}

export type NeemRuntimeConfig<
  TEntry = NeemWorker<unknown, unknown>,
  THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = NeemRuntimeSharedConfig<TEntry, THost> &
  (
    | { worker: NeemRuntimeWorkerConfig; host?: NeemRuntimeHostConfig<THost> }
    | { worker?: undefined; host: NeemRuntimeHostConfig<THost> }
  )

export type NeemRuntimeConfigBase =
  | {
      worker: NeemRuntimeWorkerConfig
      host?: NeemRuntimeHostConfig
      artifacts?: readonly NeemArtifact[]
      threads?: number | readonly unknown[]
      options?: unknown
    }
  | {
      worker?: undefined
      host: NeemRuntimeHostConfig
      artifacts?: readonly NeemArtifact[]
      threads?: number | readonly unknown[]
      options?: unknown
    }

export type NeemRuntimeConfigOverrides = {
  worker?: Partial<Pick<NeemRuntimeWorkerConfig, 'build'>>
  host?: Partial<NeemRuntimeHostConfig>
  artifacts?: readonly NeemArtifact[]
}

export type NeemRuntimeConfigInput =
  | NeemRuntimeConfigBase
  | readonly [NeemRuntimeConfigBase, NeemRuntimeConfigOverrides]

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
  plugins?: readonly NeemPluginInput[]
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
  plugins?: readonly NeemPluginInput[]
  outDir?: string
}): NeemConfig<TRuntimes> {
  return Object.freeze(config)
}

export function definePlugin<const T extends NeemPluginInput>(plugin: T): T {
  return Object.freeze(plugin)
}

export function defineRuntime<
  Entry,
  Host extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
>(config: NeemRuntimeConfig<Entry, Host>): NeemRuntimeConfig<Entry, Host> {
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
  const [runtime, overrides] = input

  return mergeRuntimeConfigOverrides(runtime, overrides)
}

function isRuntimeConfigTuple(
  input: NeemRuntimeConfigInput,
): input is readonly [NeemRuntimeConfigBase, NeemRuntimeConfigOverrides] {
  return Array.isArray(input)
}

function mergeRuntimeConfigOverrides(
  runtime: NeemRuntimeConfigBase,
  override: NeemRuntimeConfigOverrides,
): NeemRuntimeConfigBase {
  return Object.freeze({
    ...runtime,
    worker: mergeRuntimeWorkerConfig(runtime.worker, override.worker),
    host:
      override.host === undefined
        ? runtime.host
        : mergeRuntimeHostConfig(runtime.host, override.host),
    artifacts: mergeRuntimeArtifacts(runtime.artifacts, override.artifacts),
  }) as NeemRuntimeConfigBase
}

function mergeRuntimeWorkerConfig(
  base: NeemRuntimeWorkerConfig | undefined,
  override: NeemRuntimeConfigOverrides['worker'],
): NeemRuntimeWorkerConfig | undefined {
  if (!base) return undefined
  if (!override) return base

  return {
    ...base,
    ...override,
    build: mergeRuntimeBuildConfig(base.build, override.build),
  }
}

function mergeRuntimeHostConfig(
  base: NeemRuntimeHostConfig | undefined,
  override: Partial<NeemRuntimeHostConfig>,
): NeemRuntimeHostConfig {
  const host = {
    ...base,
    ...override,
    build: mergeRuntimeBuildConfig(base?.build, override.build),
  }

  if (!host.entry) {
    throw new Error(
      'Runtime host override must include entry when base runtime has no host.',
    )
  }

  return host as NeemRuntimeHostConfig
}

function mergeRuntimeBuildConfig(
  base: NeemRuntimeBuildConfig | undefined,
  override: NeemRuntimeBuildConfig | undefined,
): NeemRuntimeBuildConfig | undefined {
  if (!base && !override) return undefined

  const rolldown = mergeRolldownOptions(base?.rolldown, override?.rolldown)

  return {
    ...(base ?? {}),
    ...(override ?? {}),
    ...(rolldown ? { rolldown } : {}),
  }
}

function mergeRuntimeArtifacts(
  base: readonly NeemArtifact[] | undefined,
  override: readonly NeemArtifact[] | undefined,
): readonly NeemArtifact[] | undefined {
  if (!base) return override
  if (!override) return base
  return [...base, ...override]
}
