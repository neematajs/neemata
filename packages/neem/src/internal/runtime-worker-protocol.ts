import type { MessagePort } from 'node:worker_threads'

import type { NeemResolvedArtifact } from '../public/artifact.ts'
import type { NeemApplicationUpstream, NeemMode } from '../public/runtime.ts'

export type NeemRuntimeWorkerData = {
  mode: NeemMode
  name: string
  data: unknown
  artifact: NeemResolvedArtifact
  artifacts: readonly NeemResolvedArtifact[]
  port: MessagePort
}

export type NeemRuntimeWorkerReloadData = {
  artifact: NeemResolvedArtifact
  artifacts: readonly NeemResolvedArtifact[]
}

export type NeemRuntimeWorkerParentMessage =
  | { type: 'stop' }
  | { type: 'reload'; data: NeemRuntimeWorkerReloadData }

export type NeemRuntimeWorkerErrorOrigin =
  | 'bootstrap'
  | 'start'
  | 'reload'
  | 'runtime'

export type NeemRuntimeWorkerReadyMessage = {
  type: 'ready'
  data: { upstreams?: readonly NeemApplicationUpstream[] }
}

export type NeemRuntimeWorkerReloadedMessage = {
  type: 'reloaded'
  data: { upstreams?: readonly NeemApplicationUpstream[] }
}

export type NeemRuntimeWorkerErrorMessage = {
  type: 'error'
  data: {
    message: string
    name?: string
    stack?: string
    origin: NeemRuntimeWorkerErrorOrigin
  }
}

export type NeemRuntimeWorkerStoppedMessage = { type: 'stopped' }

export type NeemRuntimeWorkerMessage =
  | NeemRuntimeWorkerReadyMessage
  | NeemRuntimeWorkerReloadedMessage
  | NeemRuntimeWorkerErrorMessage
  | NeemRuntimeWorkerStoppedMessage
