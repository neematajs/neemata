import type { MessagePort } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type { NeemArtifactRegistry, NeemResolvedArtifact } from './artifact.ts'

export type NeemMode = 'development' | 'production'

export type NeemMaybePromise<T> = T | Promise<T>

export type NeemRuntimeUpstream = { type: string; url: string }

export type NeemRuntimeStartResult = {
  upstreams?: readonly NeemRuntimeUpstream[]
}

export type NeemRuntime = {
  start: () => NeemMaybePromise<
    readonly NeemRuntimeUpstream[] | NeemRuntimeStartResult | undefined
  >
  stop: () => NeemMaybePromise<void>
}

export type NeemRuntimeThreadPlan<Data = unknown> = {
  name: string
  artifact: string | NeemResolvedArtifact
  count?: number
  data?: Data
}

export type NeemRuntimePlan = { threads?: readonly NeemRuntimeThreadPlan[] }

export type NeemRuntimeThreadHandle = NeemManagedWorkerHandle & {
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
  plan?: () => NeemMaybePromise<NeemRuntimePlan>
  start?: (params: NeemRuntimeHostStartedParams) => NeemMaybePromise<void>
  stop?: (params: NeemRuntimeHostStoppedParams) => NeemMaybePromise<void>
  fail?: (params: NeemRuntimeHostFailedParams) => NeemMaybePromise<void>
}

export type NeemRuntimeHostFactory<
  Options = unknown,
  THost extends NeemRuntimeHost = NeemRuntimeHost,
> = (params: NeemRuntimeHostParams<Options>) => NeemMaybePromise<THost>

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
