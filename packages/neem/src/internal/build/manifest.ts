import type {
  NeemArtifactKind,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'

export const NEEM_MANIFEST_FILE = 'neem.manifest.json'
export const NEEM_MANIFEST_SCHEMA_VERSION = 1

export type NeemBuildManifestArtifact = {
  id: string
  kind: NeemArtifactKind
  owner: NeemResolvedArtifact['owner']
  file: string
  outDir: string
}

export type NeemBuildManifest = {
  schemaVersion: typeof NEEM_MANIFEST_SCHEMA_VERSION
  runtime?: { entry: string; worker: string }
  config: { file: string }
  runtimes?: Record<
    string,
    {
      name: string
      entry: NeemBuildManifestArtifact
      host?: NeemBuildManifestArtifact
      artifacts: NeemBuildManifestArtifact[]
    }
  >
}
