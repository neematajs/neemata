import type { MessagePort } from 'node:worker_threads'

import type {
  NeemMode,
  NeemResolvedArtifact,
  NeemRuntimePlan,
  NeemRuntimeThreadHandle,
} from '../../shared/types.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'
import type { SerializedError } from '../utils.ts'

export type HostRunnerData = {
  mode: NeemMode
  runtimeName: string
  hostArtifact: NeemResolvedArtifact
  plannerArtifact: NeemResolvedArtifact
  outDir: string
  logger?: ManifestLogger
}

export type HostRunnerCommand =
  | { type: 'plan' }
  | { type: 'start'; threads: readonly NeemRuntimeThreadHandle[] }
  | { type: 'stop' }
  | { type: 'shutdown' }

// The transport (HostRunner) assigns request ids; callers send bare commands.
export type HostRunnerRequest = HostRunnerCommand & { id: number }

export type HostRunnerResponse =
  | { id: number; type: 'result'; data?: HostRunnerResult }
  | { id: number; type: 'error'; error: SerializedError }
  | { type: 'ready' }
  | { type: 'failure'; error: SerializedError }

export type HostRunnerResult = { plan?: NeemRuntimePlan }

export function getTransferList(
  request: HostRunnerCommand,
): readonly MessagePort[] {
  if (request.type !== 'start') return []
  return request.threads.map((thread) => thread.port)
}
