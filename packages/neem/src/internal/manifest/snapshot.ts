import { resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'

import type { NeemMode, NeemResolvedArtifact } from '../../shared/types.ts'
import type { ScopedArtifactRegistry } from './artifacts.ts'
import type { Manifest, ManifestArtifact, ManifestConfig } from './manifest.ts'
import { createDefaultLogger } from '../shared/logger.ts'
import { createArtifactRegistry } from './artifacts.ts'

export type RuntimeSnapshot = {
  mode: NeemMode
  outDir: string
  manifestFile?: string
  manifest: Manifest
  config: ManifestConfig
  logger: Logger
  artifacts: ScopedArtifactRegistry
  workerEntry: string
}

export function createRuntimeSnapshot(options: {
  mode: NeemMode
  outDir: string
  manifest: Manifest
  manifestFile?: string
  logger?: Logger
}): RuntimeSnapshot {
  return {
    mode: options.mode,
    outDir: options.outDir,
    manifestFile: options.manifestFile,
    manifest: options.manifest,
    config: options.manifest.config,
    logger: options.logger ?? createDefaultLogger(options.mode),
    artifacts: createArtifactRegistry(
      resolveManifestArtifacts(options.outDir, options.manifest),
    ),
    workerEntry: resolve(options.outDir, options.manifest.runtime.worker.file),
  }
}

function resolveManifestArtifacts(
  outDir: string,
  manifest: Manifest,
): NeemResolvedArtifact[] {
  const artifacts: NeemResolvedArtifact[] = []

  for (const runtime of Object.values(manifest.runtimes)) {
    if (runtime.worker)
      artifacts.push(resolveManifestArtifact(outDir, runtime.worker))
    artifacts.push(resolveManifestArtifact(outDir, runtime.host))
    artifacts.push(resolveManifestArtifact(outDir, runtime.planner))
  }

  return artifacts
}

function resolveManifestArtifact(
  outDir: string,
  artifact: ManifestArtifact,
): NeemResolvedArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    owner: artifact.owner,
    file: resolve(outDir, artifact.file),
    outDir: resolve(outDir, artifact.outDir),
  }
}
