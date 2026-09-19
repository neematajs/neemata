import { Buffer } from 'node:buffer'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import type { NeemEnv, NeemResolvedArtifact } from '../../shared/types.ts'
import type { CompiledGraph } from '../build/compiler.ts'
import type { BuildTargetKind } from '../build/graph.ts'
import type { Manifest } from '../schemas/manifest.ts'
import { MANIFEST_FILE, OUT_LAYOUT } from '../layout.ts'
import { isLoggerModuleInput } from '../logger.ts'
import {
  assertRuntimeNamesExist,
  normalizeRuntimeNames,
} from '../runtime-selection.ts'
import {
  NEEM_MANIFEST_SCHEMA_VERSION,
  parseManifest,
} from '../schemas/manifest.ts'

export type { Manifest }

export type ManifestArtifact = Manifest['runtime']['start']
export type ManifestConfig = Manifest['config']
export type ManifestLogger = NonNullable<ManifestConfig['logger']>
export type ManifestPlugin = NonNullable<Manifest['plugins']>[number]
export type ManifestRuntimeConfig = ManifestConfig['runtimes'][string]

export function createManifest(compiled: CompiledGraph): Manifest {
  const { outDir } = compiled.graph
  const start = toManifestArtifact(
    outDir,
    getRequiredArtifact(compiled, 'start-entry'),
  )
  const workerEntry = toManifestArtifact(
    outDir,
    getRequiredArtifact(compiled, 'worker-entry'),
  )

  return {
    schemaVersion: NEEM_MANIFEST_SCHEMA_VERSION,
    runtime: { entry: OUT_LAYOUT.startEntry, start, worker: workerEntry },
    plugins: createPlugins(compiled, outDir),
    config: createConfig(compiled),
    runtimes: Object.fromEntries(
      compiled.runtimes.map(({ node, worker, host, planner }) => [
        node.name,
        {
          name: node.name,
          env: nonEmptyEnv(node.declaration.declaration.env),
          worker: worker
            ? toManifestArtifact(outDir, worker.artifact)
            : undefined,
          host: toManifestArtifact(outDir, host.artifact),
          planner: toManifestArtifact(outDir, planner.artifact),
        },
      ]),
    ),
  }
}

export async function readManifest(manifestFile: string): Promise<Manifest> {
  const content = await readFile(manifestFile, 'utf8')
  return parseManifest(JSON.parse(content))
}

export async function writeManifest(
  outDir: string,
  manifest: Manifest,
): Promise<string> {
  const parsed = parseManifest(manifest)
  await mkdir(outDir, { recursive: true })
  const manifestFile = resolve(outDir, MANIFEST_FILE)
  await writeFile(`${manifestFile}.tmp`, `${JSON.stringify(parsed, null, 2)}\n`)
  await rename(`${manifestFile}.tmp`, manifestFile)
  await writeStartEntries(outDir, Object.keys(parsed.runtimes))
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
  const { id, kind, owner } = artifact
  const file = toManifestPath(manifestDir, artifact.file)
  const outDir = toManifestPath(manifestDir, artifact.outDir)
  return { id, kind, owner, file, outDir }
}

export async function assertManifestFilesExist(
  outDir: string,
  manifest: Manifest,
): Promise<void> {
  const files: Array<{ label: string; file: string }> = [
    { label: 'runtime.entry', file: manifest.runtime.entry },
    { label: 'runtime.start.file', file: manifest.runtime.start.file },
    { label: 'runtime.worker.file', file: manifest.runtime.worker.file },
  ]

  if (manifest.config.logger?.type === 'module') {
    files.push({
      label: 'config.logger.file',
      file: manifest.config.logger.file,
    })
  }

  for (const [index, plugin] of (manifest.plugins ?? []).entries()) {
    if (plugin.entry) {
      files.push({
        label: `plugins.${index}.entry.file`,
        file: plugin.entry.file,
      })
    }
  }

  for (const [name, runtime] of Object.entries(manifest.runtimes)) {
    if (runtime.worker) {
      files.push({
        label: `runtimes.${name}.worker.file`,
        file: runtime.worker.file,
      })
    }
    files.push(
      { label: `runtimes.${name}.host.file`, file: runtime.host.file },
      { label: `runtimes.${name}.planner.file`, file: runtime.planner.file },
    )
  }

  for (const { label, file } of files) {
    try {
      await access(resolve(outDir, file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Missing Neem manifest file [${label}]: ${file}`)
      }
      throw error
    }
  }
}

export async function writeStartEntries(
  outDir: string,
  runtimeNames: readonly string[],
): Promise<void> {
  const runtimeStartFile = resolve(outDir, OUT_LAYOUT.runtimeStartEntry)
  await writeFile(
    resolve(outDir, OUT_LAYOUT.startEntry),
    renderStartEntry(outDir, runtimeStartFile),
  )

  await Promise.all(
    runtimeNames.map(async (name) => {
      const dir = resolve(
        outDir,
        OUT_LAYOUT.runtimeStarts,
        toRuntimeStartDirName(name),
      )
      await mkdir(dir, { recursive: true })
      await writeFile(
        resolve(dir, OUT_LAYOUT.startEntry),
        renderStartEntry(dir, runtimeStartFile, name),
      )
    }),
  )
}

function renderStartEntry(
  fromDir: string,
  runtimeStartFile: string,
  runtimeName?: string,
): string {
  const specifier = toImportSpecifier(fromDir, runtimeStartFile)
  const options =
    runtimeName === undefined
      ? ''
      : `{ runtimes: [${JSON.stringify(runtimeName)}] }`
  return [
    `import { startStandalone } from ${JSON.stringify(specifier)}`,
    `await startStandalone(${options})`,
    '',
  ].join('\n')
}

const SAFE_RUNTIME_START_DIR_NAME = /^[A-Za-z0-9_-]+$/

function toRuntimeStartDirName(name: string): string {
  if (SAFE_RUNTIME_START_DIR_NAME.test(name)) return name
  return `~${Buffer.from(name, 'utf8').toString('base64url')}`
}

function toImportSpecifier(fromDir: string, target: string): string {
  const specifier = toManifestPath(fromDir, target)
  return specifier.startsWith('.') ? specifier : `./${specifier}`
}

function getRequiredArtifact(
  compiled: CompiledGraph,
  kind: BuildTargetKind,
): NeemResolvedArtifact {
  const target = compiled.targets.find((target) => target.target.kind === kind)
  if (!target) throw new Error(`Compiled Neem ${kind} artifact is missing`)
  return target.artifact
}

function createConfig(compiled: CompiledGraph): ManifestConfig {
  const { proxy, health } = compiled.graph.config

  return {
    logger: createLogger(compiled),
    env: nonEmptyEnv(compiled.graph.config.env),
    proxy,
    health,
    runtimes: Object.fromEntries(
      compiled.runtimes.map(({ node }) => [
        node.name,
        { proxy: node.declaration.declaration.proxy },
      ]),
    ),
  }
}

// An empty env object is indistinguishable from no env for consumers, and
// omitting it keeps the written manifest free of empty objects.
function nonEmptyEnv(env: NeemEnv | undefined): NeemEnv | undefined {
  if (!env || Object.keys(env).length === 0) return undefined
  return { ...env }
}

function createLogger(compiled: CompiledGraph): ManifestLogger | undefined {
  const logger = compiled.graph.config.logger
  if (!logger) return undefined
  if (isLoggerModuleInput(logger)) {
    const artifact = getRequiredArtifact(compiled, 'logger')
    const file = toManifestPath(compiled.graph.outDir, artifact.file)
    return { type: 'module', file }
  }
  return { type: 'options', options: logger }
}

function createPlugins(
  compiled: CompiledGraph,
  outDir: string,
): ManifestPlugin[] | undefined {
  if (compiled.plugins.length === 0) return undefined

  return compiled.plugins.map((plugin) => {
    const { name, options } = plugin.node
    const entry = plugin.entry
      ? { file: toManifestPath(outDir, plugin.entry.artifact.file) }
      : undefined
    return { name, entry, options }
  })
}
