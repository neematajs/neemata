import type { MessagePort } from 'node:worker_threads'

import type {
  NeemMode,
  NeemResolvedArtifact,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'

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

export type WorkerErrorOrigin = 'bootstrap' | 'start' | 'runtime'

export type ReadyMessage = {
  type: 'ready'
  data: { upstreams?: readonly NeemRuntimeUpstream[] }
}

export type ErrorMessage = {
  type: 'error'
  data: {
    message: string
    name?: string
    stack?: string
    origin: WorkerErrorOrigin
  }
}

export type StoppedMessage = { type: 'stopped' }

export type WorkerMessage = ReadyMessage | ErrorMessage | StoppedMessage
