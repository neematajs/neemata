import { isAbsolute, normalize, resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type { NeemNormalizedConfig } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '../build/manifest.ts'
import type { NeemScopedArtifactRegistry } from './artifact-registry.ts'
import { NEEM_MANIFEST_SCHEMA_VERSION } from '../build/manifest.ts'
import { createNeemArtifactRegistry } from './artifact-registry.ts'
import { createNeemDefaultLogger } from './logger.ts'

export type NeemRuntimeSnapshot = {
  mode: NeemMode
  outDir: string
  manifestFile?: string
  manifest: NeemBuildManifest
  config: NeemNormalizedConfig
  configFile: string
  runtimeWorkerEntry?: string | URL
  logger: Logger
  artifacts: NeemScopedArtifactRegistry
}

export type NeemRuntimeSnapshotInput = {
  mode: NeemMode
  outDir: string
  manifestFile?: string
  manifest: NeemBuildManifest
  config: NeemNormalizedConfig
  configFile?: string
  runtimeWorkerEntry?: string | URL
  logger?: Logger
}

export function createRuntimeSnapshot(
  input: NeemRuntimeSnapshotInput,
): NeemRuntimeSnapshot {
  validateManifest(input.manifest)

  return Object.freeze({
    mode: input.mode,
    outDir: input.outDir,
    manifestFile: input.manifestFile,
    manifest: input.manifest,
    config: input.config,
    configFile:
      input.configFile ??
      input.manifestFile ??
      resolve(input.outDir, 'neem.config'),
    runtimeWorkerEntry: input.runtimeWorkerEntry,
    logger: input.logger ?? createNeemDefaultLogger(input.mode),
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

  for (const runtime of Object.values(manifest.runtimes ?? {})) {
    artifacts.push(resolveManifestArtifact(outDir, runtime.entry))
    if (runtime.host) {
      artifacts.push(resolveManifestArtifact(outDir, runtime.host))
    }
    for (const artifact of runtime.artifacts) {
      artifacts.push(resolveManifestArtifact(outDir, artifact))
    }
  }

  return artifacts
}

function validateManifest(manifest: NeemBuildManifest): void {
  if (manifest.schemaVersion !== NEEM_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Neem manifest schema version [${String(manifest.schemaVersion)}]`,
    )
  }

  if (manifest.config.logger?.type === 'module') {
    assertManifestPath(manifest.config.logger.file, 'config.logger.file')
  }

  for (const [runtimeName, runtime] of Object.entries(
    manifest.runtimes ?? {},
  )) {
    if (runtime.name !== runtimeName) {
      throw new Error(
        `Invalid Neem manifest runtime [${runtimeName}]: runtime name must match manifest key`,
      )
    }

    assertRuntimeArtifact(runtimeName, runtime.entry, 'entry')
    if (runtime.entry.id !== 'entry') {
      throw new Error(
        `Invalid Neem manifest runtime [${runtimeName}]: entry artifact id must be [entry]`,
      )
    }

    if (runtime.host) {
      assertRuntimeArtifact(runtimeName, runtime.host, 'host')
      if (runtime.host.id !== 'host') {
        throw new Error(
          `Invalid Neem manifest runtime [${runtimeName}]: host artifact id must be [host]`,
        )
      }
    }

    for (const artifact of runtime.artifacts) {
      assertRuntimeArtifact(runtimeName, artifact, `artifact [${artifact.id}]`)
    }
  }
}

function assertRuntimeArtifact(
  runtimeName: string,
  artifact: NeemBuildManifestArtifact,
  label: string,
): void {
  if (
    artifact.owner.type !== 'runtime' ||
    artifact.owner.name !== runtimeName
  ) {
    throw new Error(
      `Invalid Neem manifest runtime [${runtimeName}]: ${label} owner must be runtime [${runtimeName}]`,
    )
  }

  assertManifestPath(artifact.file, `${runtimeName}.${label}.file`)
  assertManifestPath(artifact.outDir, `${runtimeName}.${label}.outDir`)
}

function assertManifestPath(path: string, label: string): void {
  if (!path || isAbsolute(path) || normalize(path).startsWith('..')) {
    throw new Error(
      `Invalid Neem manifest path [${label}]: paths must be relative to output directory`,
    )
  }
}

function resolveManifestArtifact(
  outDir: string,
  artifact: NeemBuildManifestArtifact,
): NeemResolvedArtifact {
  if (artifact.kind !== 'worker' && artifact.kind !== 'module') {
    throw new Error(
      `Invalid Neem manifest artifact kind [${String(artifact.kind)}] for artifact [${artifact.id}]`,
    )
  }

  return {
    id: artifact.id,
    kind: artifact.kind,
    owner: artifact.owner,
    file: resolve(outDir, artifact.file),
    outDir: resolve(outDir, artifact.outDir),
  }
}
