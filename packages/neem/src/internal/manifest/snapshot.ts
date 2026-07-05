import { resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'

import type { NeemMode, NeemResolvedArtifact } from '../../shared/types.ts'
import type { ScopedArtifactRegistry } from './artifacts.ts'
import type { Manifest, ManifestArtifact, ManifestConfig } from './manifest.ts'
import { createDefaultLogger } from '../logger.ts'
import { createArtifactRegistry } from './artifacts.ts'
import {
  applyHostConfigEnvOverrides,
  formatAppliedEnvOverride,
} from './env-overrides.ts'

export type RuntimeSnapshot = {
  mode: NeemMode
  outDir: string
  env?: NodeJS.ProcessEnv
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
  env?: NodeJS.ProcessEnv
  manifest: Manifest
  manifestFile?: string
  logger?: Logger
}): RuntimeSnapshot {
  const logger = options.logger ?? createDefaultLogger(options.mode)
  // Snapshot creation is the single choke point shared by `neem start`,
  // standalone start.js, and reloads, so deploy-time env overrides applied
  // here reach every consumer of the effective host config.
  const { config, applied, warnings } = applyHostConfigEnvOverrides(
    options.manifest.config,
    { ...process.env, ...options.env },
  )
  for (const override of applied)
    logger.info(formatAppliedEnvOverride(override))
  for (const warning of warnings) logger.warn(warning)

  return {
    mode: options.mode,
    outDir: options.outDir,
    env: options.env,
    manifestFile: options.manifestFile,
    manifest: options.manifest,
    config,
    logger,
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
