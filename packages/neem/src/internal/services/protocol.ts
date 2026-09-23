import type { WorkerUpdateBatch } from '../build/updates.ts'
import type { NoParams } from '../rpc.ts'
import type { SerializedError } from '../utils.ts'

/**
 * Commands the watcher service serves. `start` runs one at a time; the rest
 * may overlap, as the dev session's event queue already orders the ones that
 * depend on each other. The reply to `stop` precedes the service's exit.
 */
export type WatcherCommands = {
  start: {
    params: {
      configFile: string
      outDir: string
      runtimes?: readonly string[]
    }
    result: WatcherStartResult
  }
  stop: { params: NoParams; result: void }
  'patch-client-started': { params: PatchClientParams; result: void }
  'patch-client-stopped': { params: PatchClientParams; result: void }
  'patch-delivered': {
    params: { runtimeName: string; filenames: readonly string[] }
    result: void
  }
  'ensure-worker-output': {
    params: { runtimeName: string }
    result: WatcherManifestIdentity | undefined
  }
}

export const WATCHER_SERIAL_COMMANDS = [
  'start',
] as const satisfies readonly (keyof WatcherCommands)[]

type PatchClientParams = { runtimeName: string; clientId: string }

export type WatcherStartResult = {
  manifestFile: string
  configSignalFiles: readonly string[]
}

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
      updates: WorkerUpdateBatch
    }
  | { type: 'worker-patch-failed'; runtimeName: string; reason: string }
  | ({ type: 'ready' } & WatcherManifestIdentity)
  | { type: 'config-invalidated' }
  | WatcherManifestChangeEvent
  | { type: 'error'; error: SerializedError }
