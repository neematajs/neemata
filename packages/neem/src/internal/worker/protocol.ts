import type { MessagePort } from 'node:worker_threads'

import type { BindingClientHmrUpdate } from 'rolldown/experimental'

import type { NeemWorkerErrorOrigin } from '../../shared/errors.ts'
import type {
  NeemMode,
  NeemResolvedArtifact,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
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

export type ParentMessage =
  | { type: 'stop' }
  | {
      id: number
      type: 'patch-update'
      update: BindingClientHmrUpdate['update']
      url?: string
    }

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

export type ReadyMessage = {
  type: 'ready'
  data: { upstreams?: readonly NeemRuntimeUpstream[] }
}

export type ErrorMessage = {
  type: 'error'
  data: SerializedError & { origin: WorkerErrorOrigin }
}

export type StoppedMessage = { type: 'stopped' }

export type WorkerMessage =
  | ReadyMessage
  | ErrorMessage
  | StoppedMessage
  | { id: number; type: 'result'; data: WorkerPatchResult }
