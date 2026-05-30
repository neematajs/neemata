import type { MessagePort } from 'node:worker_threads'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type { NeemMode, NeemRuntimeUpstream } from '../../public/runtime.ts'
import type { NeemBuildManifestLogger } from '../build/manifest.ts'

export type NeemRuntimeWorkerBaseData = {
  mode: NeemMode
  runtimeName: string
  name: string
  data: unknown
  artifact: NeemResolvedArtifact
  artifacts: readonly NeemResolvedArtifact[]
  outDir: string
  logger?: NeemBuildManifestLogger
  port: MessagePort
}

export type NeemGenericRuntimeWorkerData = NeemRuntimeWorkerBaseData

export type NeemRuntimeWorkerData = NeemGenericRuntimeWorkerData

export type NeemRuntimeWorkerParentMessage = { type: 'stop' }

export type NeemRuntimeWorkerErrorOrigin = 'bootstrap' | 'start' | 'runtime'

export type NeemRuntimeWorkerReadyMessage = {
  type: 'ready'
  data: { upstreams?: readonly NeemRuntimeUpstream[] }
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
  | NeemRuntimeWorkerErrorMessage
  | NeemRuntimeWorkerStoppedMessage
