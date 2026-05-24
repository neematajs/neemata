import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { consola } from 'consola'
import { colorize } from 'consola/utils'

import type {
  NeemArtifact,
  NeemResolvedArtifact,
} from '../../public/artifact.ts'
import type {
  NeemBuildConfig,
  NeemBuildConfigInput,
  NeemConfig,
  NeemRuntimeHostInput,
} from '../../public/config.ts'
import type {
  NeemConfigDiscovery,
  NeemDiscoveredImport,
} from '../build/discovery.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '../build/manifest.ts'
import { discoverConfigEntriesSync } from '../build/discovery.ts'
import {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'
import { buildArtifact } from '../build/rolldown.ts'
import { importDefault } from '../runtime/utils.ts'

export type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '../build/manifest.ts'
export {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'

export type NeemBuildOptions = {
  config?: string
  outDir?: string
  cwd?: string
  runtimes?: readonly string[]
}

export type NeemBuildResult = {
  configFile: string
  outDir: string
  manifestFile: string
  manifest: NeemBuildManifest
}

export async function buildNeem(
  options: NeemBuildOptions = {},
): Promise<NeemBuildResult> {
  const cwd = options.cwd ?? process.cwd()
  const configFile = resolve(cwd, options.config ?? 'neem.config.ts')
  const discovery = discoverConfigEntriesSync(configFile)
  const config = await importDefault<NeemConfig>(configFile)
  const outDir = resolve(cwd, options.outDir ?? config.outDir ?? 'dist')
  const logger = consola.create({ level: process.env.TEST ? 0 : 4 })

  logger.start('Building Neem bundle')
  logger.debug(`  config: ${configFile}`)
  logger.debug(`  outDir: ${outDir}`)
  const selectedRuntimes = normalizeSelectedRuntimes(options.runtimes)
  if (selectedRuntimes) {
    logger.debug(`  runtimes: ${selectedRuntimes.join(', ')}`)
  }

  await cleanNeemOutDir(outDir)
  await mkdir(outDir, { recursive: true })

  const runtimeArtifacts = await buildRuntimeArtifacts({ outDir })
  const configArtifact = await buildConfigArtifact({
    configFile,
    discovery,
    outDir,
    minify: true,
  })

  const manifest: NeemBuildManifest = {
    schemaVersion: NEEM_MANIFEST_SCHEMA_VERSION,
    runtime: {
      entry: 'start.js',
      worker: toManifestPath(outDir, runtimeArtifacts.worker.file),
    },
    config: { file: toManifestPath(outDir, configArtifact.file) },
    runtimes: {},
  }

  const runtimeEntries = Object.entries(config.runtimes ?? {}).filter(
    ([name]) => shouldBuildName(name, selectedRuntimes),
  )
  assertSelectedRuntimesExist(selectedRuntimes, [
    ...Object.keys(config.runtimes ?? {}),
  ])

  for (const [name, runtimeConfig] of runtimeEntries) {
    const discovered = discovery.runtimes[name]

    if (!discovered) {
      throw new Error(`Failed to discover runtime entry for [${name}]`)
    }

    const rolldown = await loadBuildConfig(runtimeConfig.build)

    logger.start(`Building runtime: ${colorize('green', name)}`)

    const entry = await buildArtifact({
      artifact: {
        id: 'entry',
        kind: 'worker',
        entry: discovered.entry.resolved,
      },
      owner: { type: 'runtime', name },
      rolldown,
      outDir,
      minify: true,
    })

    const hostRolldown = await loadBuildConfig(
      getRuntimeHostBuildConfig(runtimeConfig.host),
    )
    const host = discovered.host
    const hostArtifact = host
      ? await buildArtifact({
          artifact: { id: 'host', kind: 'module', entry: host.entry.resolved },
          owner: { type: 'runtime', name },
          rolldown: hostRolldown,
          outDir,
          minify: true,
        })
      : undefined

    const artifacts: NeemBuildManifestArtifact[] = []
    const declaredArtifacts =
      (await runtimeConfig.artifacts?.({
        mode: 'production',
        name,
        options: runtimeConfig.options,
      })) ?? []
    for (const artifact of declaredArtifacts) {
      const built = await buildArtifact({
        artifact: resolveRuntimeArtifactEntry(
          artifact,
          discovered.entry.resolved,
        ),
        owner: { type: 'runtime', name },
        rolldown,
        cwd: dirname(discovered.entry.resolved),
        outDir,
        minify: true,
      })
      artifacts.push(toManifestArtifact(outDir, built))
    }

    manifest.runtimes![name] = {
      name,
      entry: toManifestArtifact(outDir, entry),
      host: hostArtifact ? toManifestArtifact(outDir, hostArtifact) : undefined,
      artifacts,
    }
  }

  const manifestFile = await writeManifest(outDir, manifest)
  await writeStandaloneStartEntries(
    outDir,
    Object.keys(manifest.runtimes ?? {}),
  )
  logger.success('Neem build complete')
  logger.info(`manifest: ${manifestFile}`)
  logger.info(`runtimes: ${Object.keys(manifest.runtimes ?? {}).length}`)

  return { configFile, outDir, manifestFile, manifest }
}

export async function cleanNeemOutDir(outDir: string): Promise<void> {
  await Promise.all([
    rm(resolve(outDir, 'start.js'), { force: true }),
    rm(resolve(outDir, 'start.js.map'), { force: true }),
    rm(resolve(outDir, 'runtime'), { recursive: true, force: true }),
    rm(resolve(outDir, 'runtimes'), { recursive: true, force: true }),
    rm(resolve(outDir, 'config'), { recursive: true, force: true }),
    rm(resolve(outDir, NEEM_MANIFEST_FILE), { force: true }),
  ])
}

async function writeStandaloneStartEntries(
  outDir: string,
  runtimeNames: readonly string[],
): Promise<void> {
  await writeFile(
    resolve(outDir, 'start.js'),
    [
      `import { startStandalone } from ${JSON.stringify('./runtime/start.js')}`,
      '',
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
          '',
          `await startStandalone({ runtimes: [${JSON.stringify(name)}] })`,
          '',
        ].join('\n'),
      )
    }),
  )
}

export async function buildRuntimeArtifacts(options: {
  outDir: string
}): Promise<{ entry: NeemResolvedArtifact; worker: NeemResolvedArtifact }> {
  const entry = await buildArtifact({
    artifact: {
      id: 'entry',
      kind: 'module',
      entry: resolveNeemRuntimeSourceEntry('standalone-entry'),
      rolldown: {
        output: {
          entryFileNames: 'runtime/start.js',
          chunkFileNames: 'runtime/[name]-[hash].js',
          assetFileNames: 'runtime/[name]-[hash][extname]',
        },
      },
    },
    owner: { type: 'runtime', name: 'start' },
    artifactOutDir: options.outDir,
    outDir: options.outDir,
    minify: true,
  })

  const worker = await buildArtifact({
    artifact: {
      id: 'worker',
      kind: 'worker',
      entry: resolveNeemRuntimeSourceEntry('worker-entry'),
      rolldown: { output: { entryFileNames: 'worker-entry.js' } },
    },
    owner: { type: 'runtime', name: 'worker' },
    artifactOutDir: resolve(options.outDir, 'runtime'),
    outDir: options.outDir,
    minify: true,
  })

  return { entry, worker }
}

function resolveNeemRuntimeSourceEntry(name: string): URL {
  const sourceEntry = new URL(`../runtime/${name}.ts`, import.meta.url)
  if (existsSync(sourceEntry)) return sourceEntry

  return new URL(`../../../src/internal/runtime/${name}.ts`, import.meta.url)
}

export async function buildConfigArtifact(options: {
  configFile: string
  discovery: NeemConfigDiscovery
  outDir: string
  minify?: boolean
}): Promise<NeemResolvedArtifact> {
  const generatedEntry = await createConfigArtifactEntry(options)

  try {
    return await buildArtifact({
      artifact: { id: 'entry', kind: 'module', entry: generatedEntry },
      owner: { type: 'config' },
      rolldown: createConfigRolldownOptions(options.discovery),
      outDir: options.outDir,
      minify: options.minify,
    })
  } finally {
    if (generatedEntry !== options.configFile) {
      await rm(generatedEntry, { force: true })
    }
  }
}

async function createConfigArtifactEntry(options: {
  configFile: string
  discovery: NeemConfigDiscovery
  outDir: string
}): Promise<string> {
  const logger = options.discovery.logger
  if (!logger || logger.source !== 'specifier') return options.configFile

  const file = resolve(options.outDir, '.neem-config-entry.mjs')
  await writeFile(
    file,
    [
      `import config from ${JSON.stringify(pathToFileURL(options.configFile).href)}`,
      `import logger from ${JSON.stringify(pathToFileURL(logger.resolved).href)}`,
      '',
      'export default { ...config, logger }',
      '',
    ].join('\n'),
  )
  return file
}

export function createConfigRolldownOptions(
  discovery: NeemConfigDiscovery | (() => NeemConfigDiscovery),
): NeemBuildConfig {
  const imports =
    typeof discovery === 'function'
      ? () => collectDiscoveredLazyImports(discovery())
      : constantImports(collectDiscoveredLazyImports(discovery))
  return {
    external(id: string) {
      return imports().has(id)
    },
  }
}

export async function loadBuildConfig(
  input: NeemBuildConfigInput | undefined,
): Promise<NeemBuildConfig | undefined> {
  if (!input) return undefined
  return (await input()).default
}

function getRuntimeHostBuildConfig(
  input: NeemRuntimeHostInput | undefined,
): NeemBuildConfigInput | undefined {
  return typeof input === 'function' ? undefined : input?.build
}

function resolveRuntimeArtifactEntry(
  artifact: NeemArtifact,
  entryFile: string,
): NeemArtifact {
  if (artifact.entry instanceof URL) return artifact
  return { ...artifact, entry: resolve(dirname(entryFile), artifact.entry) }
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

export async function writeManifest(
  outDir: string,
  manifest: NeemBuildManifest,
): Promise<string> {
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

function collectDiscoveredLazyImports(
  discovery: NeemConfigDiscovery,
): Set<string> {
  const imports = new Set<string>()
  const add = (entry: NeemDiscoveredImport | undefined) => {
    if (!entry) return
    imports.add(entry.specifier)
    imports.add(entry.resolved)
  }

  for (const runtime of Object.values(discovery.runtimes)) {
    add(runtime.entry)
    add(runtime.build)
    add(runtime.host?.entry)
    add(runtime.host?.build)
  }
  return imports
}

function constantImports(imports: Set<string>): () => Set<string> {
  return () => imports
}

function normalizeSelectedRuntimes(
  runtimes: readonly string[] | undefined,
): readonly string[] | undefined {
  const selected = runtimes?.map((runtime) => runtime.trim()).filter(Boolean)
  return selected && selected.length > 0 ? [...new Set(selected)] : undefined
}

function shouldBuildName(
  name: string,
  selected: readonly string[] | undefined,
): boolean {
  return !selected || selected.includes(name)
}

function assertSelectedRuntimesExist(
  selected: readonly string[] | undefined,
  available: readonly string[],
): void {
  if (!selected) return
  const missing = selected.filter((name) => !available.includes(name))
  if (missing.length > 0) {
    throw new Error(`Unknown Neem runtime(s): ${missing.join(', ')}`)
  }
}
