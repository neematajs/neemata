import type { BindingClientHmrUpdate } from 'rolldown/experimental'

import type { NeemMode, NeemRuntimeServerHealth } from '../../shared/types.ts'
import type { SerializedError } from '../utils.ts'

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

export type WatcherSyncHmrClientsRequest = {
  id: number
  type: 'sync-hmr-clients'
  runtimeName: string
  clientIds: readonly string[]
}

export type WatcherHmrDeliveredRequest = {
  id: number
  type: 'hmr-delivered'
  runtimeName: string
  filenames: readonly string[]
}

export type WatcherPrepareHmrFallbackRequest = {
  id: number
  type: 'prepare-hmr-fallback'
  runtimeName: string
}

export type WatcherRequest =
  | WatcherStartRequest
  | WatcherStopRequest
  | WatcherSyncHmrClientsRequest
  | WatcherHmrDeliveredRequest
  | WatcherPrepareHmrFallbackRequest

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
  | {
      type: 'runtime-hmr-update'
      runtimeName: string
      updates: readonly BindingClientHmrUpdate[]
    }
  | { type: 'runtime-hmr-fallback'; runtimeName: string; reason: string }
  | WatcherManifestChangeEvent
  | { type: 'error'; error: SerializedError }

export type WatcherResult = {
  manifestFile?: string
  configSignalFiles?: readonly string[]
}

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

export type RuntimeApplyHmrRequest = {
  id: number
  type: 'apply-hmr'
  runtimeName: string
  updates: readonly BindingClientHmrUpdate[]
}

export type RuntimeStopRequest = { id: number; type: 'stop' }

export type RuntimeRequest =
  | RuntimeStartRequest
  | RuntimeReloadRequest
  | RuntimeReloadRuntimeRequest
  | RuntimeApplyHmrRequest
  | RuntimeStopRequest

export type RuntimeEvent =
  | { type: 'ready'; health: NeemRuntimeServerHealth }
  | { type: 'stopped' }
  | { type: 'error'; error: SerializedError }

export type RuntimeHmrResult = {
  accepted: boolean
  deliveredFiles: readonly string[]
  reason?: string
}

export type RuntimeResult = {
  health?: NeemRuntimeServerHealth
  hmr?: RuntimeHmrResult
}

export type RuntimeResponse = ServiceResponse<RuntimeEvent, RuntimeResult>
