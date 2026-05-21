import type { NeemResolvedArtifact } from '../../public/artifact.ts'

export const NEEM_MANIFEST_FILE = 'neem.manifest.json'
export const NEEM_MANIFEST_SCHEMA_VERSION = 1

export type NeemBuildManifestArtifact = {
  id: string
  kind: string
  owner: NeemResolvedArtifact['owner']
  file: string
  outDir: string
}

export type NeemBuildManifest = {
  schemaVersion: typeof NEEM_MANIFEST_SCHEMA_VERSION
  runtime?: { entry: string; worker: string }
  config: { file: string }
  apps: Record<string, { name: string; entry: NeemBuildManifestArtifact }>
  plugins: Array<{
    index: number
    name: string
    entry: NeemBuildManifestArtifact
    artifacts: NeemBuildManifestArtifact[]
  }>
}
