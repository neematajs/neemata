import type { NeemArtifactRegistry, NeemResolvedArtifact } from './artifact.ts'
import type { NeemMaybePromise, NeemMode, NeemRuntime } from './runtime.ts'

export type NeemAppRuntimeContext<
  ThreadOptions = unknown,
  Definition = unknown,
> = {
  mode: NeemMode
  appName: string
  threadIndex: number
  threadOptions: ThreadOptions
  definition: Definition
  artifacts: NeemArtifactRegistry
  artifact: NeemResolvedArtifact
}

export type NeemApp<ThreadOptions = unknown, Definition = unknown> = {
  _: { threadOptions: ThreadOptions; definition: Definition }
  kind: string
  definition: Definition
  createRuntime: (
    ctx: NeemAppRuntimeContext<ThreadOptions, Definition>,
  ) => NeemMaybePromise<NeemRuntime>
}

export type InferNeemThreadOptions<TApp> =
  TApp extends NeemApp<infer TThreadOptions, any> ? TThreadOptions : unknown

export function defineApp<
  ThreadOptions = unknown,
  Definition = unknown,
  const TApp extends NeemApp<ThreadOptions, Definition> = NeemApp<
    ThreadOptions,
    Definition
  >,
>(app: Omit<TApp, '_'>): TApp {
  return Object.freeze(app) satisfies Omit<TApp, '_'> as TApp
}
