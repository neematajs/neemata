import type { MessagePort } from 'node:worker_threads'

import type { NeemMode, NeemResolvedArtifact } from '../../shared/types.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'

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
