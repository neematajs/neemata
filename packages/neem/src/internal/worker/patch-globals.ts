import type { WorkerUpdate } from '../build/updates.ts'
import type { PatchClientResult } from './protocol.ts'

/**
 * The globals shared by the worker entry and the patch client Rolldown
 * injects into development worker artifacts (build/patch-client.js). The
 * entry sets the client id and accept hook before importing the artifact; the
 * client installs `__neem_patches__` while the artifact evaluates.
 */
export type PatchGlobal = typeof globalThis & {
  __neem_patch_client_id__?: string
  __neem_accept_worker__?: (worker: unknown) => Promise<void>
  __neem_patches__?: PatchClient
}

export type PatchClient = {
  clientId: string
  // `load` imports the patch file; the client calls it only once the update
  // passes its checks, which is what makes a patch delivered.
  apply: (
    update: WorkerUpdate,
    load: () => Promise<unknown>,
  ) => Promise<PatchClientResult>
}

/**
 * The patch client reports an accept failure as an unavailable generation
 * unless the error carries this mark: the running generation was never
 * touched and keeps serving, so the patch is only rejected.
 */
export type GenerationIntactMark = { neemGenerationIntact?: true }

export function markGenerationIntact(error: Error): Error {
  return Object.assign(error, { neemGenerationIntact: true as const })
}
