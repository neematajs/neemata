import type {
  NeemArtifact,
  NeemArtifactRegistry,
  NeemResolvedArtifact,
} from './artifact.ts'
import type {
  NeemManagedWorkerHandle,
  NeemMaybePromise,
  NeemMode,
} from './runtime.ts'

export type NeemPluginArtifactContext<Options = unknown> = {
  mode: NeemMode
  name: string
  instanceId: number
  options: Options
}

export type NeemPluginWorkerSpawnOptions = {
  id?: string
  name: string
  artifact: string | NeemResolvedArtifact
  workerData?: Record<string, unknown>
}

export type NeemPluginWorkers = {
  spawn: (
    options: NeemPluginWorkerSpawnOptions,
  ) => Promise<NeemManagedWorkerHandle>
  stop: (workerId: string) => Promise<boolean>
  list: () => readonly NeemManagedWorkerHandle[]
}

export type NeemPluginContext<Options = unknown> = {
  mode: NeemMode
  name: string
  instanceId: number
  options: Options
  artifacts: NeemArtifactRegistry
  workers: NeemPluginWorkers
}

export type NeemPlugin<Options = unknown> = {
  name: string
  artifacts?: (
    ctx: NeemPluginArtifactContext<Options>,
  ) => NeemMaybePromise<readonly NeemArtifact[]>
  setup?: (ctx: NeemPluginContext<Options>) => NeemMaybePromise<void>
  stop?: (ctx: NeemPluginContext<Options>) => NeemMaybePromise<void>
}

export type InferNeemPluginOptions<TPlugin> =
  TPlugin extends NeemPlugin<infer Options> ? Options : unknown

export function definePlugin<
  Options = unknown,
  const TPlugin extends NeemPlugin<Options> = NeemPlugin<Options>,
>(plugin: TPlugin): TPlugin {
  return Object.freeze(plugin)
}
