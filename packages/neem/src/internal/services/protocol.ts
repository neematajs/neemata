import type { NeemMode, NeemRuntimeServerHealth } from '../../shared/types.ts'
import type { RpcResponse } from '../rpc.ts'
import type { SerializedError } from '../utils.ts'

export type ServiceResponse<TEvent, TResult = unknown> =
  | RpcResponse<TResult>
  | { type: 'event'; event: TEvent }

// The transport (WorkerServiceClient) assigns request ids; callers send bare
// commands.
export type WatcherCommand =
  | {
      type: 'start'
      configFile: string
      outDir: string
      runtimes?: readonly string[]
    }
  | { type: 'stop' }

export type WatcherRequest = WatcherCommand & { id: number }

export type WatcherManifestIdentity = {
  manifestFile: string
  manifestRevision: number
  manifestHash: string
}

export type WatcherChange =
  | { type: 'runtime-changed'; runtimeName: string }
  | { type: 'runtime-host-changed'; runtimeName: string }
  | { type: 'plugin-changed' }
  | { type: 'logger-changed' }

export type WatcherManifestChangeEvent = WatcherChange & WatcherManifestIdentity

export type WatcherEvent =
  | ({ type: 'ready' } & WatcherManifestIdentity)
  | { type: 'config-invalidated' }
  | WatcherManifestChangeEvent
  | { type: 'error'; error: SerializedError }

export type WatcherResult = {
  manifestFile: string
  configSignalFiles: readonly string[]
}

export type WatcherResponse = ServiceResponse<WatcherEvent, WatcherResult>

export type RuntimeCommand =
  | {
      type: 'start'
      mode: NeemMode
      outDir: string
      env?: NodeJS.ProcessEnv
      manifestFile: string
      runtimes?: readonly string[]
    }
  | { type: 'reload-runtime'; runtimeName: string; manifestFile: string }
  | { type: 'stop' }

export type RuntimeRequest = RuntimeCommand & { id: number }

export type RuntimeEvent =
  | { type: 'ready'; health: NeemRuntimeServerHealth }
  | { type: 'stopped' }
  | { type: 'error'; error: SerializedError }

export type RuntimeResult = { health: NeemRuntimeServerHealth }

export type RuntimeResponse = ServiceResponse<RuntimeEvent, RuntimeResult>
