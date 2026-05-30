import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve } from 'node:path'

import type {
  NeemArtifactKind,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'
import type {
  NeemHealthConfig,
  NeemLoggerOptions,
  NeemNormalizedConfig,
  NeemProxyConfig,
} from '../../public/config.ts'
import {
  assertSelectedRuntimeNamesExist,
  normalizeSelectedRuntimeNames,
} from './runtime-selection.ts'

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
  commands?: Record<string, { file: string }>
  runtimes: Record<string, NeemBuildManifestRuntimeConfig>
}

export type NeemBuildManifestPlugin = {
  name: string
  entry?: { file: string }
  options?: unknown
}

export type NeemBuildManifest = {
  schemaVersion: typeof NEEM_MANIFEST_SCHEMA_VERSION
  runtime?: { entry: string; worker: string }
  plugins?: readonly NeemBuildManifestPlugin[]
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

type ManifestParser = (
  value: unknown,
  manifestFile: string,
) => NeemBuildManifest

const manifestParsers = {
  [NEEM_MANIFEST_SCHEMA_VERSION]: parseManifestV1,
} satisfies Record<number, ManifestParser>

export async function readManifest(
  manifestFile: string,
): Promise<NeemBuildManifest> {
  const value = JSON.parse(await readFile(manifestFile, 'utf8')) as unknown
  const schemaVersion =
    typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? value.schemaVersion
      : undefined
  const parser = manifestParsers[Number(schemaVersion)]
  if (!parser) {
    throw new Error(
      `Unsupported Neem manifest schema version [${String(schemaVersion)}] at [${manifestFile}]`,
    )
  }

  return parser(value, manifestFile)
}

export async function writeManifest(
  outDir: string,
  manifest: NeemBuildManifest,
): Promise<string> {
  validateManifest(manifest)
  await mkdir(outDir, { recursive: true })
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  await writeFile(
    `${manifestFile}.tmp`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await rename(`${manifestFile}.tmp`, manifestFile)
  return manifestFile
}

export function toManifestPath(fromDir: string, target: string): string {
  return relative(fromDir, target).replace(/\\/g, '/')
}

export function toManifestArtifact(
  manifestDir: string,
  artifact: NeemResolvedArtifact,
): NeemBuildManifestArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    owner: artifact.owner,
    file: toManifestPath(manifestDir, artifact.file),
    outDir: toManifestPath(manifestDir, artifact.outDir),
  }
}

export function selectManifestRuntimes(
  manifest: NeemBuildManifest,
  runtimes: readonly string[] | undefined,
): NeemBuildManifest {
  const names = normalizeSelectedRuntimeNames(runtimes)
  if (!names) return manifest

  const available = Object.keys(manifest.runtimes ?? {})
  assertSelectedRuntimeNamesExist(names, available)
  const selected = new Set(names)

  return {
    ...manifest,
    config: {
      ...manifest.config,
      runtimes: Object.fromEntries(
        Object.entries(manifest.config.runtimes).filter(([name]) =>
          selected.has(name),
        ),
      ),
    },
    runtimes: Object.fromEntries(
      Object.entries(manifest.runtimes ?? {}).filter(([name]) =>
        selected.has(name),
      ),
    ),
  }
}

export function createRuntimeConfigFromManifest(
  manifest: NeemBuildManifest,
): NeemNormalizedConfig {
  return {
    proxy: manifest.config.proxy,
    health: manifest.config.health,
    commands: manifest.config.commands
      ? Object.fromEntries(
          Object.keys(manifest.config.commands).map((name) => [name, '']),
        )
      : undefined,
    runtimes: Object.fromEntries(
      Object.entries(manifest.config.runtimes).map(([name, runtime]) => [
        name,
        {
          worker: { entry: '' },
          threads: runtime.threads,
          options: runtime.options,
        },
      ]),
    ),
  }
}

export function validateManifest(manifest: NeemBuildManifest): void {
  if (manifest.schemaVersion !== NEEM_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Neem manifest schema version [${String(manifest.schemaVersion)}]`,
    )
  }

  if (manifest.runtime) {
    assertManifestPath(manifest.runtime.entry, 'runtime.entry')
    assertManifestPath(manifest.runtime.worker, 'runtime.worker')
  }

  if (manifest.config.logger?.type === 'module') {
    assertManifestPath(manifest.config.logger.file, 'config.logger.file')
  }

  for (const [name, command] of Object.entries(
    manifest.config.commands ?? {},
  )) {
    assertManifestPath(command.file, `config.commands.${name}.file`)
  }

  for (const [index, plugin] of (manifest.plugins ?? []).entries()) {
    if (!plugin.name.trim()) {
      throw new Error(
        `Invalid Neem manifest plugin [${index}]: name is required`,
      )
    }
    if (plugin.entry) {
      assertManifestPath(plugin.entry.file, `plugins.${index}.entry.file`)
    }
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

export function assertManifestPath(path: string, label: string): void {
  if (!path || isAbsolute(path) || normalize(path).startsWith('..')) {
    throw new Error(
      `Invalid Neem manifest path [${label}]: paths must be relative to output directory`,
    )
  }
}

function parseManifestV1(
  value: unknown,
  _manifestFile: string,
): NeemBuildManifest {
  const manifest = value as NeemBuildManifest
  validateManifest(manifest)
  return manifest
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
