import type { WorkerUpdate } from '../build/updates.ts'
import type { PatchClientResult } from './protocol.ts'

/**
 * The globals shared by the worker entry and the patch client Rolldown
 * injects into development worker artifacts (injected/patch-client.js). The
 * entry sets the client id, guard and accept hook before importing the
 * artifact; the client installs `__neem_patches__` while the artifact
 * evaluates.
 */
export type PatchGlobal = typeof globalThis & {
  __neem_patch_client_id__?: string
  // Called before the client disposes anything: a reason refuses the patch
  // while the running generation is still intact.
  __neem_patch_guard__?: () => string | undefined
  // Called from the worker definition's accept callback, after disposal: any
  // failure leaves no generation serving.
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
