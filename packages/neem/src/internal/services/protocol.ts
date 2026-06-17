import type { NeemMode, NeemRuntimeServerHealth } from '../../shared/types.ts'
import type { SerializedError } from '../shared/utils.ts'

export type ServiceResponse<TEvent, TResult = unknown> =
  | { id: number; type: 'result'; data?: TResult }
  | { id: number; type: 'error'; error: SerializedError }
  | { type: 'event'; event: TEvent }

export type WatcherStartRequest = {
  id: number
  type: 'start'
  configFile: string
  outDir: string
  runtimes?: readonly string[]
}

export type WatcherStopRequest = { id: number; type: 'stop' }

export type WatcherRequest = WatcherStartRequest | WatcherStopRequest

export type WatcherManifestIdentity = {
  manifestFile: string
  manifestRevision: number
  manifestHash: string
}

export type WatcherManifestChangeEvent =
  | ({ type: 'runtime-changed'; runtimeName: string } & WatcherManifestIdentity)
  | ({
      type: 'runtime-host-changed'
      runtimeName: string
    } & WatcherManifestIdentity)
  | ({ type: 'plugin-changed' } & WatcherManifestIdentity)
  | ({ type: 'logger-changed' } & WatcherManifestIdentity)

export type WatcherEvent =
  | ({ type: 'ready' } & WatcherManifestIdentity)
  | { type: 'config-invalidated' }
  | WatcherManifestChangeEvent
  | { type: 'error'; error: SerializedError }

export type WatcherResult = { manifestFile?: string }

export type WatcherResponse = ServiceResponse<WatcherEvent, WatcherResult>

export type RuntimeStartRequest = {
  id: number
  type: 'start'
  mode: NeemMode
  outDir: string
  env?: NodeJS.ProcessEnv
  manifestFile: string
  runtimes?: readonly string[]
}

export type RuntimeReloadRequest = {
  id: number
  type: 'reload'
  manifestFile: string
}

export type RuntimeReloadRuntimeRequest = {
  id: number
  type: 'reload-runtime'
  runtimeName: string
  manifestFile: string
}

export type RuntimeStopRequest = { id: number; type: 'stop' }

export type RuntimeRequest =
  | RuntimeStartRequest
  | RuntimeReloadRequest
  | RuntimeReloadRuntimeRequest
  | RuntimeStopRequest

export type RuntimeEvent =
  | { type: 'ready'; health: NeemRuntimeServerHealth }
  | { type: 'stopped' }
  | { type: 'error'; error: SerializedError }

export type RuntimeResult = { health?: NeemRuntimeServerHealth }

export type RuntimeResponse = ServiceResponse<RuntimeEvent, RuntimeResult>
