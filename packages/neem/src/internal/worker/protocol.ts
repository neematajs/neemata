import type { MessagePort } from 'node:worker_threads'

import type { BindingClientHmrUpdate } from 'rolldown/experimental'

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
  hmrClientId?: string
}

export type ParentMessage =
  | { type: 'stop' }
  | {
      id: number
      type: 'hmr-update'
      update: BindingClientHmrUpdate['update']
      url?: string
    }

export type WorkerHmrResult = {
  accepted: boolean
  delivered: boolean
  reason?: string
}

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

export type HmrResultMessage = {
  id: number
  type: 'result'
  data: WorkerHmrResult
}

export type WorkerMessage =
  | ReadyMessage
  | ErrorMessage
  | StoppedMessage
  | HmrResultMessage
