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

export type NeemArtifactOwner =
  | { type: 'config' }
  | { type: 'app'; name: string }
  | { type: 'plugin'; name: string; instanceId: number }

export type NeemResolvedArtifact = {
  id: string
  kind: NeemArtifactKind
  owner: NeemArtifactOwner
  file: string
  outDir: string
  bundle?: RolldownOutput
}

export type NeemArtifactRegistry = {
  resolve: (id: string) => NeemResolvedArtifact | undefined
  list: () => readonly NeemResolvedArtifact[]
}
