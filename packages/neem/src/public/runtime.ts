export type NeemMode = 'development' | 'production'

export type NeemMaybePromise<T> = T | Promise<T>

export type NeemApplicationUpstream = { type: string; url: string }

export type NeemRuntime = {
  start: () => NeemMaybePromise<readonly NeemApplicationUpstream[] | undefined>
  stop: () => NeemMaybePromise<void>
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
