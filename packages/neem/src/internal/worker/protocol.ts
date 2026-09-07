import type { MessagePort } from 'node:worker_threads'

import type { NeemWorkerErrorOrigin } from '../../shared/errors.ts'
import type {
  NeemMode,
  NeemResolvedArtifact,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'
import type { SerializedError } from '../utils.ts'

export type RuntimeWorkerData = {
  mode: NeemMode
  runtimeName: string
  name: string
  data: unknown
  artifact: NeemResolvedArtifact
  outDir: string
  logger?: ManifestLogger
  port: MessagePort
}

export type ParentMessage = { type: 'stop' }

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

export type WorkerMessage = ReadyMessage | ErrorMessage | StoppedMessage
