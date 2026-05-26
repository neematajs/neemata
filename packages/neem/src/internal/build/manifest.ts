import type {
  NeemArtifactKind,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'
import type {
  NeemHealthConfig,
  NeemLoggerOptions,
  NeemProxyConfig,
} from '../../public/config.ts'

export const NEEM_MANIFEST_FILE = 'neem.manifest.json'
export const NEEM_MANIFEST_SCHEMA_VERSION = 1

export type NeemBuildManifestArtifact = {
  id: string
  kind: NeemArtifactKind
  owner: NeemResolvedArtifact['owner']
  file: string
  outDir: string
}

export type NeemBuildManifestLogger =
  | { type: 'options'; options: NeemLoggerOptions }
  | { type: 'module'; file: string }

export type NeemBuildManifestRuntimeConfig = {
  threads?: number | readonly unknown[]
  options?: unknown
}

export type NeemBuildManifestConfig = {
  logger?: NeemBuildManifestLogger
  proxy?: NeemProxyConfig
  health?: NeemHealthConfig
  runtimes: Record<string, NeemBuildManifestRuntimeConfig>
}

export type NeemBuildManifest = {
  schemaVersion: typeof NEEM_MANIFEST_SCHEMA_VERSION
  runtime?: { entry: string; worker: string }
  config: NeemBuildManifestConfig
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
