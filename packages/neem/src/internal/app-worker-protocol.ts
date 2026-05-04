import type { NeemResolvedArtifact } from '../public/artifact.ts'
import type { NeemApplicationUpstream, NeemMode } from '../public/runtime.ts'

export type NeemAppWorkerData = {
  mode: NeemMode
  appName: string
  threadIndex: number
  threadOptions: unknown
  appArtifact: NeemResolvedArtifact
  artifacts: readonly NeemResolvedArtifact[]
}

export type NeemAppWorkerParentMessage = { type: 'stop' }

export type NeemAppWorkerErrorOrigin = 'bootstrap' | 'start' | 'runtime'

export type NeemAppWorkerReadyMessage = {
  type: 'ready'
  data: { upstreams?: readonly NeemApplicationUpstream[] }
}

export type NeemAppWorkerErrorMessage = {
  type: 'error'
  data: {
    message: string
    name?: string
    stack?: string
    origin: NeemAppWorkerErrorOrigin
  }
}

export type NeemAppWorkerStoppedMessage = { type: 'stopped' }

export type NeemAppWorkerMessage =
  | NeemAppWorkerReadyMessage
  | NeemAppWorkerErrorMessage
  | NeemAppWorkerStoppedMessage
