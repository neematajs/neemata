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

export type NeemRuntimeHostContext<Options = unknown> = {
  mode: NeemMode
  name: string
  options: Options
  logger: Logger
  artifact: NeemResolvedArtifact
  hostArtifact?: NeemResolvedArtifact
  artifacts: NeemArtifactRegistry
}

export type NeemRuntimeStartedContext<Options = unknown> =
  NeemRuntimeHostContext<Options> & {
    threads: readonly NeemRuntimeThreadHandle[]
    upstreams: readonly NeemRuntimeUpstream[]
  }

export type NeemRuntimeStoppedContext<Options = unknown> =
  NeemRuntimeHostContext<Options> & {
    threads: readonly NeemRuntimeThreadHandle[]
  }

export type NeemRuntimeFailedContext<Options = unknown> =
  NeemRuntimeHostContext<Options> & {
    error: Error
    threads: readonly NeemRuntimeThreadHandle[]
  }

export type NeemRuntimeHost<Options = unknown> = {
  setup?: (ctx: NeemRuntimeHostContext<Options>) => NeemMaybePromise<void>
  plan?: (
    ctx: NeemRuntimeHostContext<Options>,
  ) => NeemMaybePromise<NeemRuntimePlan>
  start?: (ctx: NeemRuntimeStartedContext<Options>) => NeemMaybePromise<void>
  stop?: (ctx: NeemRuntimeStoppedContext<Options>) => NeemMaybePromise<void>
  fail?: (ctx: NeemRuntimeFailedContext<Options>) => NeemMaybePromise<void>
}

export function defineRuntimeHost<const THost extends NeemRuntimeHost>(
  host: THost,
): THost {
  return Object.freeze(host)
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
