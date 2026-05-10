import { resolve } from 'node:path'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type { NeemConfig } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '../build/manifest.ts'
import type { NeemScopedArtifactRegistry } from './artifact-registry.ts'
import { createNeemArtifactRegistry } from './artifact-registry.ts'

export type NeemRuntimeSnapshot = {
  mode: NeemMode
  outDir: string
  manifestFile?: string
  manifest: NeemBuildManifest
  config: NeemConfig
  artifacts: NeemScopedArtifactRegistry
}

export type NeemRuntimeSnapshotInput = {
  mode: NeemMode
  outDir: string
  manifestFile?: string
  manifest: NeemBuildManifest
  config: NeemConfig
}

export function createRuntimeSnapshot(
  input: NeemRuntimeSnapshotInput,
): NeemRuntimeSnapshot {
  return Object.freeze({
    mode: input.mode,
    outDir: input.outDir,
    manifestFile: input.manifestFile,
    manifest: input.manifest,
    config: input.config,
    artifacts: createNeemArtifactRegistry(
      resolveManifestArtifacts(input.outDir, input.manifest),
    ),
  })
}

function resolveManifestArtifacts(
  outDir: string,
  manifest: NeemBuildManifest,
): NeemResolvedArtifact[] {
  const artifacts: NeemResolvedArtifact[] = []

  for (const app of Object.values(manifest.apps)) {
    artifacts.push(resolveManifestArtifact(outDir, app.entry))
  }

  for (const plugin of manifest.plugins) {
    artifacts.push(resolveManifestArtifact(outDir, plugin.entry))
    for (const artifact of plugin.artifacts) {
      artifacts.push(resolveManifestArtifact(outDir, artifact))
    }
  }

  return artifacts
}

function resolveManifestArtifact(
  outDir: string,
  artifact: NeemBuildManifestArtifact,
): NeemResolvedArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind as NeemResolvedArtifact['kind'],
    owner: artifact.owner,
    file: resolve(outDir, artifact.file),
    outDir: resolve(outDir, artifact.outDir),
  }
}
