import type { BindingClientHmrUpdate } from 'rolldown/experimental'

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

export type WatcherRequest =
  | WatcherStartRequest
  | WatcherStopRequest
  | {
      id: number
      type: 'patch-client-started' | 'patch-client-stopped'
      runtimeName: string
      clientId: string
    }
  | {
      id: number
      type: 'patch-delivered'
      runtimeName: string
      filenames: readonly string[]
    }
  | { id: number; type: 'ensure-worker-output'; runtimeName: string }

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
  | {
      type: 'worker-patch'
      runtimeName: string
      updates: BindingClientHmrUpdate[]
    }
  | { type: 'worker-patch-failed'; runtimeName: string; reason: string }
  | ({ type: 'ready' } & WatcherManifestIdentity)
  | { type: 'config-invalidated' }
  | WatcherManifestChangeEvent
  | { type: 'error'; error: SerializedError }

export type WatcherResult = {
  manifestFile?: string
  manifest?: WatcherManifestIdentity
  configSignalFiles?: readonly string[]
}

export type WatcherResponse = ServiceResponse<WatcherEvent, WatcherResult>
