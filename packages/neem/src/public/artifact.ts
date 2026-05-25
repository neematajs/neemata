import type { RolldownOptions, RolldownOutput } from 'rolldown'

export type NeemArtifactKind = 'worker' | 'module'

export type NeemArtifactEntry = string | URL

export type NeemRolldownOptions = RolldownOptions

export type NeemArtifact = {
  id: string
  kind: NeemArtifactKind
  entry: NeemArtifactEntry
  rolldown?: NeemRolldownOptions
}

export type NeemRuntimeBuildHost = {
  entry: NeemArtifactEntry
  build?: NeemArtifactEntry
}

export type NeemRuntimeBuildMetadata = {
  host?: NeemRuntimeBuildHost
  artifacts?: readonly NeemArtifact[]
  rolldown?: NeemRolldownOptions
}

export type NeemArtifactOwner =
  | { type: 'config' }
  | { type: 'runtime'; name: string }

export type NeemResolvedArtifact = {
  id: string
  kind: NeemArtifactKind
  owner: NeemArtifactOwner
  file: string
  outDir: string
  bundle?: RolldownOutput
  emittedArtifacts?: readonly NeemResolvedArtifact[]
}

export type NeemArtifactRegistry = {
  resolve: (id: string) => NeemResolvedArtifact | undefined
  list: () => readonly NeemResolvedArtifact[]
}
