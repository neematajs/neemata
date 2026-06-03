import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, normalize, relative, resolve } from 'node:path'

import type {
  NeemArtifactKind,
  NeemHealthConfig,
  NeemLoggerOptions,
  NeemProxyConfig,
  NeemResolvedArtifact,
} from '../../shared/types.ts'
import type { CompiledGraph } from '../build/compiler.ts'
import {
  assertRuntimeNamesExist,
  normalizeRuntimeNames,
} from '../shared/runtime-selection.ts'

export const MANIFEST_FILE = 'neem.manifest.json'
export const MANIFEST_SCHEMA_VERSION = 1

export type ManifestArtifact = {
  id: string
  kind: NeemArtifactKind
  owner: NeemResolvedArtifact['owner']
  file: string
  outDir: string
}

export type ManifestLogger =
  | { type: 'options'; options: NeemLoggerOptions }
  | { type: 'module'; file: string }

export type ManifestRuntimeConfig = { static?: true }

export type ManifestConfig = {
  logger?: ManifestLogger
  proxy?: NeemProxyConfig
  health?: NeemHealthConfig
  runtimes: Record<string, ManifestRuntimeConfig>
}

export type ManifestPlugin = {
  name: string
  entry?: { file: string }
  options?: unknown
}

export type Manifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION
  runtime: { entry: string; start: ManifestArtifact; worker: ManifestArtifact }
  plugins?: readonly ManifestPlugin[]
  config: ManifestConfig
  runtimes: Record<
    string,
    {
      name: string
      worker?: ManifestArtifact
      host: ManifestArtifact
      planner: ManifestArtifact
    }
  >
}

export function createManifest(compiled: CompiledGraph): Manifest {
  const outDir = compiled.graph.outDir
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runtime: {
      entry: 'start.js',
      start: toManifestArtifact(
        outDir,
        getRequiredArtifact(compiled, 'start-entry'),
      ),
      worker: toManifestArtifact(outDir, getWorkerEntryArtifact(compiled)),
    },
    plugins: createManifestPlugins(compiled, outDir),
    config: createManifestConfig(compiled),
    runtimes: {},
  }

  for (const runtime of compiled.runtimes) {
    manifest.runtimes[runtime.name] = {
      name: runtime.name,
      worker: runtime.worker
        ? toManifestArtifact(outDir, runtime.worker.artifact)
        : undefined,
      host: toManifestArtifact(outDir, runtime.host.artifact),
      planner: toManifestArtifact(outDir, runtime.planner.artifact),
    }
  }

  validateManifest(manifest)
  return manifest
}

export async function readManifest(manifestFile: string): Promise<Manifest> {
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Manifest
  validateManifest(manifest)
  return manifest
}

export async function writeManifest(
  outDir: string,
  manifest: Manifest,
): Promise<string> {
  validateManifest(manifest)
  await mkdir(outDir, { recursive: true })
  const manifestFile = resolve(outDir, MANIFEST_FILE)
  await writeFile(
    `${manifestFile}.tmp`,
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  await rename(`${manifestFile}.tmp`, manifestFile)
  await writeStartEntries(outDir, Object.keys(manifest.runtimes))
  return manifestFile
}

export function selectManifestRuntimes(
  manifest: Manifest,
  runtimes: readonly string[] | undefined,
): Manifest {
  const names = normalizeRuntimeNames(runtimes)
  if (!names) return manifest

  assertRuntimeNamesExist(names, Object.keys(manifest.runtimes))
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
      Object.entries(manifest.runtimes).filter(([name]) => selected.has(name)),
    ),
  }
}

export function toManifestPath(fromDir: string, target: string): string {
  return relative(fromDir, target).replace(/\\/g, '/')
}

export function toManifestArtifact(
  manifestDir: string,
  artifact: NeemResolvedArtifact,
): ManifestArtifact {
  return {
    id: artifact.id,
    kind: artifact.kind,
    owner: artifact.owner,
    file: toManifestPath(manifestDir, artifact.file),
    outDir: toManifestPath(manifestDir, artifact.outDir),
  }
}

export function validateManifest(manifest: Manifest): void {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Neem manifest schema version [${String(manifest.schemaVersion)}]`,
    )
  }

  if (manifest.config.logger?.type === 'module') {
    assertManifestPath(manifest.config.logger.file, 'config.logger.file')
  }

  if (!manifest.runtime?.worker) {
    throw new Error('Invalid Neem manifest runtime: worker entry is required')
  }
  assertManifestPath(manifest.runtime.entry, 'runtime.entry')
  assertManifestPath(manifest.runtime.start.file, 'runtime.start.file')
  assertManifestPath(manifest.runtime.start.outDir, 'runtime.start.outDir')
  assertManifestPath(manifest.runtime.worker.file, 'runtime.worker.file')
  assertManifestPath(manifest.runtime.worker.outDir, 'runtime.worker.outDir')

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

  for (const [runtimeName, runtime] of Object.entries(manifest.runtimes)) {
    if (runtime.name !== runtimeName) {
      throw new Error(
        `Invalid Neem manifest runtime [${runtimeName}]: runtime name must match manifest key`,
      )
    }

    if (!runtime.worker && !runtime.host) {
      throw new Error(
        `Invalid Neem manifest runtime [${runtimeName}]: worker or host artifact is required`,
      )
    }

    if (runtime.worker) {
      assertRuntimeArtifact(runtimeName, runtime.worker, 'worker')
      if (runtime.worker.id !== 'worker') {
        throw new Error(
          `Invalid Neem manifest runtime [${runtimeName}]: worker artifact id must be [worker]`,
        )
      }
    }

    assertRuntimeArtifact(runtimeName, runtime.host, 'host')
    if (runtime.host.id !== 'host') {
      throw new Error(
        `Invalid Neem manifest runtime [${runtimeName}]: host artifact id must be [host]`,
      )
    }

    assertRuntimeArtifact(runtimeName, runtime.planner, 'planner')
    if (runtime.planner.id !== 'planner') {
      throw new Error(
        `Invalid Neem manifest runtime [${runtimeName}]: planner artifact id must be [planner]`,
      )
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

export async function writeStartEntries(
  outDir: string,
  runtimeNames: readonly string[],
): Promise<void> {
  await writeFile(
    resolve(outDir, 'start.js'),
    [
      `import { startStandalone } from ${JSON.stringify('./runtime/start.js')}`,
      'await startStandalone()',
      '',
    ].join('\n'),
  )

  await Promise.all(
    runtimeNames.map(async (name) => {
      const dir = resolve(outDir, 'runtimes', name)
      await mkdir(dir, { recursive: true })
      await writeFile(
        resolve(dir, 'start.js'),
        [
          `import { startStandalone } from ${JSON.stringify('../../runtime/start.js')}`,
          `await startStandalone({ runtimes: [${JSON.stringify(name)}] })`,
          '',
        ].join('\n'),
      )
    }),
  )
}

function getWorkerEntryArtifact(compiled: CompiledGraph): NeemResolvedArtifact {
  return getRequiredArtifact(compiled, 'worker-entry')
}

function getRequiredArtifact(
  compiled: CompiledGraph,
  kind: string,
): NeemResolvedArtifact {
  const target = compiled.targets.find((target) => target.target.kind === kind)
  if (!target) throw new Error(`Compiled Neem ${kind} artifact is missing`)
  return target.artifact
}

function createManifestConfig(compiled: CompiledGraph): ManifestConfig {
  const config = compiled.graph.config
  return {
    logger: createManifestLogger(compiled),
    proxy: config.proxy,
    health: config.health,
    runtimes: Object.fromEntries(
      Object.keys(config.runtimes).map((name) => [name, {}]),
    ),
  }
}

function createManifestLogger(
  compiled: CompiledGraph,
): ManifestLogger | undefined {
  const logger = compiled.graph.config.logger
  if (!logger) return undefined
  if (typeof logger === 'string' || logger instanceof URL) {
    const target = compiled.targets.find(
      (target) => target.target.kind === 'logger',
    )
    if (!target) throw new Error('Compiled Neem logger artifact is missing')
    return {
      type: 'module',
      file: toManifestPath(compiled.graph.outDir, target.artifact.file),
    }
  }
  return { type: 'options', options: logger }
}

function createManifestPlugins(
  compiled: CompiledGraph,
  outDir: string,
): Manifest['plugins'] {
  if (compiled.plugins.length === 0) return undefined

  return compiled.plugins.map((plugin) => ({
    name: plugin.node.name,
    entry: plugin.entry
      ? { file: toManifestPath(outDir, plugin.entry.artifact.file) }
      : undefined,
    options: plugin.node.options,
  }))
}

function assertRuntimeArtifact(
  runtimeName: string,
  artifact: ManifestArtifact,
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
