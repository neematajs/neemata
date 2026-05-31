import type { MessagePort } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'

import type { NeemArtifactRegistry, NeemResolvedArtifact } from './artifact.ts'
import type { NeemMode, NeemRuntime } from './runtime.ts'

export type NeemRuntimeWorkerContext<Data = unknown, Definition = unknown> = {
  mode: NeemMode
  name: string
  data: Data
  logger: Logger
  definition: Definition
  artifact: NeemResolvedArtifact
  artifacts: NeemArtifactRegistry
  port: MessagePort
}

export type NeemRuntimeWorker<Data = unknown, Definition = unknown> = {
  _: { data: Data; definition: Definition }
  definition: Definition
  createRuntime: (
    ctx: NeemRuntimeWorkerContext<Data, Definition>,
  ) => MaybePromise<NeemRuntime>
}

export type InferNeemRuntimeWorkerData<TWorker> = TWorker extends {
  _: { data: infer TData }
}
  ? TData
  : unknown

export function defineRuntimeWorker<
  Data = unknown,
  Definition = unknown,
  const TWorker extends NeemRuntimeWorker<Data, Definition> = NeemRuntimeWorker<
    Data,
    Definition
  >,
>(worker: Omit<TWorker, '_'>): TWorker {
  return Object.freeze(worker) satisfies Omit<TWorker, '_'> as TWorker
}
