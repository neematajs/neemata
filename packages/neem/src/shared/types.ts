import type { MessagePort } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger, LoggingOptions } from '@nmtjs/core'
import type { Hookable } from 'hookable'
import type { RolldownOptions, RolldownOutput } from 'rolldown'

export type { RolldownOptions, RolldownPluginOption } from 'rolldown'

export type NeemArtifactKind = 'worker' | 'module'

export type NeemArtifactEntry = string | URL

export type NeemRolldownOptions = Omit<
  RolldownOptions,
  'input' | 'output' | 'cwd'
>

export type NeemArtifact = {
  id: string
  kind: NeemArtifactKind
  entry: NeemArtifactEntry
  rolldown?: NeemRolldownOptions
}

export type NeemRuntimeBuildMetadata = {
  artifacts?: readonly NeemArtifact[]
  rolldown?: NeemRolldownOptions
}

export type NeemArtifactOwner =
  | { type: 'config' }
  | { type: 'runtime'; name: string }

export type NeemResolvedArtifact = {
  id: string
  kind: NeemArtifactKind
  owner: NeemArtifactOwner
  file: string
  outDir: string
  bundle?: RolldownOutput
  emittedArtifacts?: readonly NeemResolvedArtifact[]
}

export type NeemArtifactRegistry = {
  resolve: (id: string) => NeemResolvedArtifact | undefined
  list: () => readonly NeemResolvedArtifact[]
}

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

export type NeemEnv = Record<string, string>

export type NeemPluginBuild = { rolldown?: RolldownOptions }

export type NeemPluginInput = {
  name: string
  entry?: NeemEntryInput
  build?: NeemPluginBuild
  options?: unknown
}

export type NeemRuntimeBuildConfig = { rolldown?: RolldownOptions }

export type NeemRuntimeWorkerDeclaration = {
  entry: NeemEntryInput
  build?: NeemRuntimeBuildConfig
}

export type NeemMode = 'development' | 'production'

export type NeemRuntimeUpstream = { type: string; url: string }

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

export type NeemRuntimeStartResult = {
  upstreams?: readonly NeemRuntimeUpstream[]
}

export type NeemRuntime = {
  start: () => MaybePromise<
    readonly NeemRuntimeUpstream[] | NeemRuntimeStartResult | undefined
  >
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

export type NeemRuntimeHostDeclaration<
  _THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = { entry?: NeemEntryInput; build?: NeemRuntimeBuildConfig }

export type NeemRuntimeDeclaration<
  THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = {
  name?: string
  planner?: NeemEntryInput
  env?: NeemEnv
  worker?: NeemRuntimeWorkerDeclaration
  host?: NeemRuntimeHostDeclaration<THost>
}

export type NeemRuntimeDeclarationLayer<
  THost extends NeemRuntimeHostFactory = NeemRuntimeHostFactory,
> = Omit<NeemRuntimeDeclaration<THost>, 'worker' | 'host'> & {
  worker?: Partial<NeemRuntimeWorkerDeclaration>
  host?: Partial<NeemRuntimeHostDeclaration<THost>>
}

export type NeemMarkedRuntimeDeclaration<
  TDeclaration extends NeemRuntimeDeclaration = NeemRuntimeDeclaration,
> = Readonly<TDeclaration>

export type NeemRuntimeProjectEntry = string

export type NeemRuntimeProjectEntries = readonly NeemRuntimeProjectEntry[]

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
  TRuntimes extends NeemRuntimeProjectEntries = NeemRuntimeProjectEntries,
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
  env?: NeemEnv
  runtimes: TRuntimes
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

export type NeemManagedWorkerHandle = {
  id: string
  name: string
  artifactId: string
  getState: () => NeemWorkerState
  stop: () => Promise<void>
}

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
