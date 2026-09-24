import type { MessagePort } from 'node:worker_threads'

import type { NeemWorkerErrorOrigin } from '../../shared/errors.ts'
import type {
  NeemMode,
  NeemResolvedArtifact,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
import type { WorkerUpdate } from '../build/updates.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'
import type { SerializedError } from '../utils.ts'

export type RuntimeWorkerData = {
  patchClientId: string
  mode: NeemMode
  runtimeName: string
  name: string
  data: unknown
  artifact: NeemResolvedArtifact
  outDir: string
  logger?: ManifestLogger
  port: MessagePort
}

/**
 * Commands a runtime worker thread serves. `patch-update` requests run one at
 * a time in arrival order, since each patch builds on the previous one; `stop`
 * may overlap anything, and its reply precedes the thread's exit.
 */
export type WorkerCommands = {
  'patch-update': {
    params: { update: WorkerUpdate; url?: string }
    result: WorkerPatchResult
  }
  // `timeoutMs`: how long the host still waits for the thread to exit, so the
  // thread can bound what it flushes before exiting.
  stop: { params: { timeoutMs: number }; result: void }
}

export const WORKER_SERIAL_COMMANDS = [
  'patch-update',
] as const satisfies readonly (keyof WorkerCommands)[]

/**
 * What a patch did to the running worker generation. `rejected` leaves the
 * generation serving; `unavailable` means it was retired and no replacement
 * came up, so the thread has nothing left to serve.
 */
export type PatchOutcome =
  | { outcome: 'applied' }
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'unavailable'; reason: string }

// What the injected DevEngine patch client returns for one update.
export type PatchClientResult = PatchOutcome & {
  // Whether the patch file was imported; DevEngine counts it as delivered.
  delivered: boolean
}

export type WorkerPatchResult = PatchClientResult & { patches: number }

export type WorkerErrorOrigin = NeemWorkerErrorOrigin

export type WorkerEvent =
  | { type: 'ready'; data: { upstreams?: readonly NeemRuntimeUpstream[] } }
  | { type: 'error'; data: SerializedError & { origin: WorkerErrorOrigin } }
