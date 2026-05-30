import type { MessagePort } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'

import type { NeemArtifactRegistry, NeemResolvedArtifact } from './artifact.ts'

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

export type NeemRuntimeThreadPlan<Data = unknown> = {
  name: string
  artifact: string | NeemResolvedArtifact
  count?: number
  data?: Data
}

export type NeemRuntimePlan = { threads?: readonly NeemRuntimeThreadPlan[] }

export type NeemRuntimeThreadHandle = {
  id: string
  name: string
  artifactId: string
  port: MessagePort
}

export type NeemRuntimeHostParams<Options = unknown> = {
  mode: NeemMode
  name: string
  options: Options
  logger: Logger
  artifact: NeemResolvedArtifact
  hostArtifact?: NeemResolvedArtifact
  artifacts: NeemArtifactRegistry
  defaultThreads: readonly NeemRuntimeThreadPlan[]
}

export type NeemRuntimeHostStartedParams = {
  threads: readonly NeemRuntimeThreadHandle[]
  upstreams: readonly NeemRuntimeUpstream[]
}

export type NeemRuntimeHostStoppedParams = {
  threads: readonly NeemRuntimeThreadHandle[]
}

export type NeemRuntimeHostFailedParams = {
  error: Error
  threads: readonly NeemRuntimeThreadHandle[]
}

export type NeemRuntimeHost = {
  plan?: () => MaybePromise<NeemRuntimePlan>
  start?: (params: NeemRuntimeHostStartedParams) => MaybePromise<void>
  stop?: (params: NeemRuntimeHostStoppedParams) => MaybePromise<void>
  fail?: (params: NeemRuntimeHostFailedParams) => MaybePromise<void>
}

export type NeemRuntimeHostFactory<
  Options = unknown,
  THost extends NeemRuntimeHost = NeemRuntimeHost,
> = (params: NeemRuntimeHostParams<Options>) => MaybePromise<THost>

export function defineRuntimeHost<
  const TFactory extends NeemRuntimeHostFactory,
>(factory: TFactory): TFactory {
  return Object.freeze(factory)
}

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
