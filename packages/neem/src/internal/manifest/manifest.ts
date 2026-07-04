import { Buffer } from 'node:buffer'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

import type {
  NeemArtifactKind,
  NeemEnv,
  NeemHealthConfig,
  NeemLoggerOptions,
  NeemProxyConfig,
  NeemResolvedArtifact,
  NeemRuntimeProxyConfig,
} from '../../shared/types.ts'
import type { CompiledGraph } from '../build/compiler.ts'
import {
  assertRuntimeNamesExist,
  normalizeRuntimeNames,
} from '../runtime-selection.ts'
import {
  NEEM_MANIFEST_SCHEMA_VERSION,
  parseManifest,
} from '../schemas/manifest.ts'

export const MANIFEST_FILE = 'neem.manifest.json'
export const MANIFEST_SCHEMA_VERSION = NEEM_MANIFEST_SCHEMA_VERSION
export { parseManifest } from '../schemas/manifest.ts'

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

export type ManifestRuntimeConfig = {
  proxy?: NeemRuntimeProxyConfig
}

export type ManifestConfig = {
  logger?: ManifestLogger
  env?: NeemEnv
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
      env?: NeemEnv
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
      env: copyEnv(runtime.node.declaration.declaration.env),
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
  return parseManifest(JSON.parse(await readFile(manifestFile, 'utf8')))
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
  return {
    id: artifact.id,
    kind: artifact.kind,
    owner: artifact.owner,
    file: toManifestPath(manifestDir, artifact.file),
    outDir: toManifestPath(manifestDir, artifact.outDir),
  }
}

export function validateManifest(
  manifest: unknown,
): asserts manifest is Manifest {
  parseManifest(manifest)
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

  for (const [runtimeName, runtime] of Object.entries(manifest.runtimes)) {
    if (runtime.worker) {
      files.push({
        label: `${runtimeName}.worker.file`,
        file: runtime.worker.file,
      })
    }
    files.push(
      { label: `${runtimeName}.host.file`, file: runtime.host.file },
      { label: `${runtimeName}.planner.file`, file: runtime.planner.file },
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
  const runtimeStartFile = resolve(outDir, 'runtime/start.js')
  await writeFile(
    resolve(outDir, 'start.js'),
    [
      `import { startStandalone } from ${JSON.stringify(toImportSpecifier(outDir, runtimeStartFile))}`,
      'await startStandalone()',
      '',
    ].join('\n'),
  )

  await Promise.all(
    runtimeNames.map(async (name) => {
      const dir = resolve(outDir, 'runtimes', toRuntimeStartDirName(name))
      await mkdir(dir, { recursive: true })
      await writeFile(
        resolve(dir, 'start.js'),
        [
          `import { startStandalone } from ${JSON.stringify(toImportSpecifier(dir, runtimeStartFile))}`,
          `await startStandalone({ runtimes: [${JSON.stringify(name)}] })`,
          '',
        ].join('\n'),
      )
    }),
  )
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
    env: copyEnv(config.env),
    proxy: config.proxy,
    health: config.health,
    runtimes: Object.fromEntries(
      compiled.runtimes.map((runtime) => [
        runtime.name,
        createManifestRuntimeConfig(runtime.node.declaration.declaration),
      ]),
    ),
  }
}

function createManifestRuntimeConfig(declaration: {
  proxy?: NeemRuntimeProxyConfig
}): ManifestRuntimeConfig {
  return declaration.proxy ? { proxy: copyRuntimeProxy(declaration.proxy) } : {}
}

function copyEnv(env: NeemEnv | undefined): NeemEnv | undefined {
  if (!env || Object.keys(env).length === 0) return undefined
  return { ...env }
}

function copyRuntimeProxy(
  proxy: NeemRuntimeProxyConfig,
): NeemRuntimeProxyConfig {
  return {
    ...(proxy.routing ? { routing: { ...proxy.routing } } : {}),
    ...(proxy.sni !== undefined ? { sni: proxy.sni } : {}),
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
