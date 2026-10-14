import type { NeemMode, NeemResolvedArtifact } from '../../shared/types.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'

export type HostRunnerData = {
  mode: NeemMode
  runtimeName: string
  hostArtifact: NeemResolvedArtifact
  plannerArtifact: NeemResolvedArtifact
  outDir: string
  logger?: ManifestLogger
}
