import type { MessagePort } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type {
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from '#public/artifact.ts'
import type {
  NeemMaybePromise,
  NeemMode,
  NeemRuntime,
} from '#public/runtime.ts'

export type NeemWorkerRuntimeContext<Data = unknown, Definition = unknown> = {
  mode: NeemMode
  name: string
  data: Data
  logger: Logger
  definition: Definition
  artifact: NeemResolvedArtifact
  artifacts: NeemArtifactRegistry
  port: MessagePort
}

export type NeemWorker<Data = unknown, Definition = unknown> = {
  _: { data: Data; definition: Definition }
  kind: string
  definition: Definition
  createRuntime: (
    ctx: NeemWorkerRuntimeContext<Data, Definition>,
  ) => NeemMaybePromise<NeemRuntime>
}

export type InferNeemWorkerData<TWorker> =
  TWorker extends NeemWorker<infer TData, any> ? TData : unknown

export function defineWorker<
  Data = unknown,
  Definition = unknown,
  const TWorker extends NeemWorker<Data, Definition> = NeemWorker<
    Data,
    Definition
  >,
>(worker: Omit<TWorker, '_'>): TWorker {
  return Object.freeze(worker) satisfies Omit<TWorker, '_'> as TWorker
}
