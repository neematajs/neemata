import type { MessagePort } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger, LoggingOptions } from '@nmtjs/core'
import type { Hookable } from 'hookable'
import type { OutputOptions, RolldownOptions } from 'rolldown'

export type { RolldownOptions, RolldownPluginOption } from 'rolldown'

export type NeemArtifactKind = 'worker' | 'module'

export type NeemArtifactEntry = string | URL

export type NeemRolldownResolveOptions = Pick<
  NonNullable<RolldownOptions['resolve']>,
  | 'alias'
  | 'conditionNames'
  | 'extensionAlias'
  | 'exportsFields'
  | 'extensions'
  | 'mainFields'
  | 'mainFiles'
  | 'modules'
  | 'symlinks'
>

export type NeemRolldownTransformOptions = Pick<
  NonNullable<RolldownOptions['transform']>,
  'define' | 'inject' | 'dropLabels' | 'jsx'
>

export type NeemRolldownOptions = Pick<
  RolldownOptions,
  'plugins' | 'external' | 'moduleTypes' | 'checks' | 'tsconfig'
> & {
  resolve?: NeemRolldownResolveOptions
  transform?: NeemRolldownTransformOptions
}

type NeemCodeSplittingOptions = Extract<
  NonNullable<OutputOptions['codeSplitting']>,
  object
>

export type NeemChunkGroup = NonNullable<
  NeemCodeSplittingOptions['groups']
>[number]

export type NeemChunkingOptions = false | { groups?: readonly NeemChunkGroup[] }

export type NeemArtifactOwner =
  | { type: 'config' }
  | { type: 'runtime'; name: string }

export type NeemResolvedArtifact = {
  id: string
  kind: NeemArtifactKind
  owner: NeemArtifactOwner
  file: string
  outDir: string
}

export type NeemArtifactRegistry = {
  resolve: (id: string) => NeemResolvedArtifact | undefined
  list: () => readonly NeemResolvedArtifact[]
}

export type NeemEntryInput = NeemArtifactEntry

export type NeemLoggerOptions = LoggingOptions

export type NeemLoggerInput = NeemLoggerOptions | string | URL

export type NeemEnv = Record<string, string>

export type NeemBuildConfig = {
  sourcemap?: OutputOptions['sourcemap']
  sourcemapSources?: 'include' | 'exclude'
  minify?: boolean | 'dce-only'
  define?: Record<string, string>
  watch?: NeemBuildWatchConfig
}

export type NeemBuildWatchConfig = {
  buildDelay?: number
  debounceDelay?: number
}

export type NeemPluginBuild = { rolldown?: NeemRolldownOptions }

export type NeemPluginInput = {
  name: string
  entry?: NeemEntryInput
  build?: NeemPluginBuild
  options?: unknown
}

export type NeemRuntimeBuildConfig = {
  rolldown?: NeemRolldownOptions
  chunks?: NeemChunkingOptions
}

export type NeemRuntimeWorkerDeclaration = {
  entry: NeemEntryInput
  build?: NeemRuntimeBuildConfig
}

export type NeemMode = 'development' | 'production'

export type NeemRuntimeUpstreamType = 'http' | 'http2' | 'ws'

export type NeemRuntimeUpstream = { type: NeemRuntimeUpstreamType; url: string }

export type NeemRuntimeServerState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'reloading'
  | 'failed'
  | 'stopping'
  | 'stopped'

export type NeemRuntimeServerSnapshot = {
  mode: NeemMode
  outDir: string
  runtimeNames: readonly string[]
  artifactCount: number
  state: NeemRuntimeServerState
  revision: number
  lastError?: Error
}

export type NeemWorkerPoolState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type NeemWorkerPoolHealth = {
  name: string
  state: NeemWorkerPoolState
  size: number
  ready: number
  failed: number
  stopped: number
  starting: number
}

export type NeemManagedWorkerHealth = {
  id: string
  name: string
  artifactId: string
  state: NeemWorkerState
  failureCount: number
  startedAt?: number
  readyAt?: number
  stoppedAt?: number
  lastError?: Error
}

export type NeemStartedRuntimeThreadHealth = NeemManagedWorkerHealth & {
  runtimeName: string
  artifact: NeemResolvedArtifact
  upstreams: readonly NeemRuntimeUpstream[]
}

export type NeemProxyUpstream = {
  type: 'port'
  transport: 'http' | 'http2' | 'ws'
  secure: boolean
  hostname: string
  port: number
}

export type NeemProxyUpstreamSnapshot = {
  runtimeName: string
  upstream: NeemRuntimeUpstream
  proxyUpstream: NeemProxyUpstream
  count: number
}

export type NeemProxyHealth = {
  enabled: boolean
  running: boolean
  ready: boolean
  upstreams: readonly NeemProxyUpstreamSnapshot[]
  appliedUpstreams: readonly NeemProxyUpstreamSnapshot[]
  pending: number
  failedUpstreams: readonly NeemProxyUpstreamFailure[]
  lastError?: Error
}

export type NeemProxyUpstreamFailure = {
  operation: 'add' | 'remove'
  upstream: NeemProxyUpstreamSnapshot
  error: Error
}

export type NeemRuntimeServerRuntimeHealth = {
  name: string
  ready: boolean
  pool: NeemWorkerPoolHealth
  threads: readonly NeemStartedRuntimeThreadHealth[]
}

export type NeemRuntimeServerHealth = NeemRuntimeServerSnapshot & {
  ready: boolean
  runtimes: readonly NeemRuntimeServerRuntimeHealth[]
  proxy: NeemProxyHealth
}

export type NeemRuntime = {
  start: () => MaybePromise<readonly NeemRuntimeUpstream[] | undefined>
  stop: () => MaybePromise<void>
}

export type NeemRuntimePlan<Options = unknown, Data = unknown> = {
  workers: readonly Data[] | Record<string, readonly Data[]>
  options?: Options
}

export type NeemRuntimePlannerContext = {
  mode: NeemMode
  name: string
  logger: Logger
}

export type NeemRuntimePlanner<Options = unknown, Data = unknown> = (
  ctx: NeemRuntimePlannerContext,
) => MaybePromise<NeemRuntimePlan<Options, Data>>

export type NeemRuntimeHostDeclaration = {
  entry?: NeemEntryInput
  build?: NeemRuntimeBuildConfig
}

export type NeemRuntimeDeclaration = {
  name?: string
  planner?: NeemEntryInput
  env?: NeemEnv
  proxy?: NeemRuntimeProxyConfig
  worker?: NeemRuntimeWorkerDeclaration
  host?: NeemRuntimeHostDeclaration
}

export type NeemRuntimeDeclarationLayer = Omit<
  NeemRuntimeDeclaration,
  'worker' | 'host'
> & {
  worker?: Partial<NeemRuntimeWorkerDeclaration>
  host?: Partial<NeemRuntimeHostDeclaration>
}

export type NeemMarkedRuntimeDeclaration<
  TDeclaration extends NeemRuntimeDeclaration = NeemRuntimeDeclaration,
> = Readonly<TDeclaration>

export type NeemRuntimeProjectEntry = string

export type NeemRuntimeProjectEntries = readonly NeemRuntimeProjectEntry[]

export type NeemProxyRoutingOptions =
  | { type: 'path'; name?: string }
  | { type: 'subdomain'; name?: string }
  | { type: 'default' }

export type NeemRuntimeProxyConfig = {
  routing?: NeemProxyRoutingOptions
  sni?: string
}

/**
 * Values are baked into the manifest at build time. Deploy-time env vars,
 * resolved when the server starts, override them: `NEEM_PROXY_PORT` (or the
 * platform-conventional `PORT` as a fallback), `NEEM_PROXY_HOSTNAME`,
 * `NEEM_PROXY_TLS_KEY_PATH` and `NEEM_PROXY_TLS_CERT_PATH` (both required to
 * enable TLS when not configured here).
 */
export type NeemProxyConfig = {
  hostname: string
  port: number
  healthChecks?: { interval?: number }
  stickySessions?: {
    enabled?: boolean
    cookieName?: string
    headerName?: string
    ttlMs?: number
    maxEntries?: number
  }
  tls?: { keyPath: string; certPath: string }
}

/**
 * Values are baked into the manifest at build time. Deploy-time env vars,
 * resolved when the server starts, override them: `NEEM_HEALTH_PORT` and
 * `NEEM_HEALTH_HOSTNAME`.
 */
export type NeemHealthConfig = {
  hostname?: string
  port: number
  paths?: { health?: string; ready?: string }
}

export type NeemConfig = {
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
  env?: NeemEnv
  build?: NeemBuildConfig
  runtimes: NeemRuntimeProjectEntries
  proxy?: NeemProxyConfig
  health?: NeemHealthConfig
  // commands?: Record<string, NeemCommandInput>
  plugins?: readonly NeemPluginInput[]
  outDir?: string
}

export type NeemResolvedRuntimeDeclaration = {
  name: string
  file: string
  directory: string
  declaration: NeemMarkedRuntimeDeclaration
  planner: NeemEntryInput
}

export type NeemResolvedRuntimeDeclarations = Record<
  string,
  NeemResolvedRuntimeDeclaration
>

export type NeemResolvedConfig = Omit<NeemConfig, 'runtimes'> & {
  runtimes: NeemResolvedRuntimeDeclarations
}

export type NeemRuntimeThreadHandle = { name: string; port: MessagePort }

export type NeemRuntimeHostFactoryParams<Options = unknown> = {
  mode: NeemMode
  name: string
  logger: Logger
  threads: readonly NeemRuntimeThreadHandle[]
  options: Options
}

export type NeemRuntimeHost = {
  start?: () => MaybePromise<void>
  stop?: () => MaybePromise<void>
}

export type NeemRuntimeHostFactory<
  Options = unknown,
  THost extends NeemRuntimeHost = NeemRuntimeHost,
> = (params: NeemRuntimeHostFactoryParams<Options>) => MaybePromise<THost>

export type NeemWorkerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type NeemRuntimeWorkerContext<Data = unknown, Definition = unknown> = {
  mode: NeemMode
  name: string
  data: Data
  logger: Logger
  definition: Definition
  port: MessagePort
}

export type NeemRuntimeWorker<Data = unknown, Definition = unknown> = {
  readonly _?: { data: Data; definition: Definition }
  definition: Definition
  createRuntime: (
    ctx: NeemRuntimeWorkerContext<Data, Definition>,
  ) => MaybePromise<NeemRuntime>
}

export type InferNeemRuntimeWorkerData<TWorker> = TWorker extends {
  readonly _?: { data: infer TData }
}
  ? TData
  : unknown

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
  initialize: (event: NeemHostHookEvent) => MaybePromise<void>
  dispose: (event: NeemHostHookEvent) => MaybePromise<void>
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

export type NeemPluginHooks = Partial<NeemHostHookMap>

export type NeemPluginHooksContext<Options = unknown> = {
  name: string
  mode: NeemMode
  options: Options
  logger: Logger
  getHealth: () => NeemRuntimeServerHealth
}

export type NeemPluginHooksFactory<Options = unknown> = (
  ctx: NeemPluginHooksContext<Options>,
) => MaybePromise<NeemPluginHooks>
