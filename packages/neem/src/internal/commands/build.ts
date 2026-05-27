import { existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

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
  NeemLoggerOptions,
  NeemRuntimeBuildConfig,
  NeemRuntimeBuildInput,
  NeemRuntimeConfigBase,
} from '../../public/config.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
  NeemBuildManifestConfig,
  NeemBuildManifestLogger,
} from '../build/manifest.ts'
import { normalizeNeemConfig } from '../../public/config.ts'
import {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'
import { resolveImportFile } from '../build/resolve.ts'
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

const logger = consola.create({ level: process.env.TEST ? 0 : 4 })

export async function buildNeem(
  options: NeemBuildOptions = {},
): Promise<NeemBuildResult> {
  const cwd = options.cwd ?? process.cwd()
  const configFile = resolve(cwd, options.config ?? 'neem.config.ts')
  const config = normalizeNeemConfig(
    await importDefault<NeemConfig>(configFile),
  )
  const outDir = resolve(cwd, options.outDir ?? config.outDir ?? 'dist')
  const selectedRuntimes =
    normalizeSelectedRuntimes(options.runtimes) || Object.keys(config.runtimes)

  logger.start('Building Neem bundle')
  logger.debug(`  config: ${colorize('green', configFile)}`)
  logger.debug(`  outDir: ${colorize('green', outDir)}`)
  logger.debug(
    `  runtimes: ${selectedRuntimes.map((v) => colorize('cyan', v)).join(', ')}`,
  )

  await cleanNeemOutDir(outDir)
  await mkdir(outDir, { recursive: true })

  logger.info('Bulding Neem runtime:')
  const runtimeArtifacts = await buildRuntimeArtifacts({ outDir })
  const manifestConfig = await createManifestConfig(config, configFile, outDir)

  const manifest: NeemBuildManifest = {
    schemaVersion: NEEM_MANIFEST_SCHEMA_VERSION,
    runtime: {
      entry: 'start.js',
      worker: toManifestPath(outDir, runtimeArtifacts.worker.file),
    },
    config: manifestConfig,
    runtimes: {},
  }

  const runtimeEntries = Object.entries(config.runtimes ?? {}).filter(
    ([name]) => shouldBuildName(name, selectedRuntimes),
  )
  assertSelectedRuntimesExist(selectedRuntimes, [
    ...Object.keys(config.runtimes ?? {}),
  ])

  for (const chunk of runtimeArtifacts.entry.bundle?.output ?? []) {
    logger.debug(`  ${chunk.type}: ${colorize('green', chunk.fileName)}`)
  }

  for (const [name, runtimeConfig] of runtimeEntries) {
    const runtimeBuild = getRuntimeBuildConfig(runtimeConfig.build)
    const rolldown = await loadBuildConfig(runtimeBuild?.config, configFile)
    const emittedArtifacts = resolveRuntimeBuildArtifacts(
      configFile,
      runtimeBuild?.artifacts,
    )

    logger.start(`Building ${colorize('cyan', name)}:`)

    const entry = await buildArtifact({
      artifact: {
        id: 'entry',
        kind: 'worker',
        entry: resolveRequiredRuntimeBuildEntry(
          configFile,
          runtimeConfig.entry,
        ),
        rolldown: runtimeBuild?.rolldown,
      },
      owner: { type: 'runtime', name },
      rolldown,
      outDir,
      emittedArtifacts,
      minify: true,
    })

    for (const chunk of entry.bundle?.output ?? []) {
      logger.debug(`  ${chunk.type}: ${colorize('green', chunk.fileName)}`)
    }

    const hostRolldown = await loadRuntimeHostBuildConfig(
      runtimeConfig,
      configFile,
    )
    const hostEntry =
      resolveRuntimeHostEntry(configFile, runtimeConfig.host) ??
      resolveRuntimeBuildEntry(configFile, runtimeBuild?.host?.entry)
    const hostArtifact = hostEntry
      ? await buildArtifact({
          artifact: { id: 'host', kind: 'module', entry: hostEntry },
          owner: { type: 'runtime', name },
          rolldown: hostRolldown,
          outDir,
          minify: true,
        })
      : undefined

    manifest.runtimes![name] = {
      name,
      entry: toManifestArtifact(outDir, entry),
      host: hostArtifact ? toManifestArtifact(outDir, hostArtifact) : undefined,
      artifacts: (entry.emittedArtifacts ?? []).map((artifact) =>
        toManifestArtifact(outDir, artifact),
      ),
    }
  }

  const manifestFile = await writeManifest(outDir, manifest)
  await writeStandaloneStartEntries(
    outDir,
    Object.keys(manifest.runtimes ?? {}),
  )
  logger.success('Neem build complete')
  logger.info(`manifest: ${colorize('green', manifestFile)}`)
  logger.info(
    `runtimes: ${colorize('green', Object.keys(manifest.runtimes ?? {}).length)}`,
  )

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
      'await startStandalone()',
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
          entryFileNames: 'start.js',
          chunkFileNames: '[name]-[hash].js',
        },
      },
    },
    owner: { type: 'runtime', name: 'start' },
    artifactOutDir: join(options.outDir, 'runtime'),
    outDir: join(options.outDir, 'runtime'),
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

export async function loadBuildConfig(
  input: NeemBuildConfigInput | undefined,
  importer: string,
): Promise<NeemBuildConfig | undefined> {
  if (!input) return undefined
  return importDefault<NeemBuildConfig>(
    resolveRequiredRuntimeBuildEntry(importer, input),
  )
}

async function loadRuntimeHostBuildConfig(
  runtimeConfig: NeemRuntimeConfigBase,
  importer: string,
): Promise<NeemBuildConfig | undefined> {
  const runtimeBuild = getRuntimeBuildConfig(runtimeConfig.build)
  if (runtimeBuild?.host?.build) {
    return loadBuildConfig(runtimeBuild.host.build, importer)
  }

  return loadBuildConfig(
    getRuntimeHostConfig(runtimeConfig.host)?.build,
    importer,
  )
}

function getRuntimeBuildConfig(
  input: NeemRuntimeBuildInput | undefined,
): NeemRuntimeBuildConfig | undefined {
  if (!input) return undefined
  return typeof input === 'string' || input instanceof URL
    ? { config: input }
    : input
}

export async function createManifestConfig(
  config: NeemConfig,
  configFile: string,
  outDir: string,
): Promise<NeemBuildManifestConfig> {
  const normalizedConfig = normalizeNeemConfig(config)

  return {
    logger: await createManifestLogger(
      normalizedConfig.logger,
      configFile,
      outDir,
    ),
    proxy: normalizedConfig.proxy,
    health: normalizedConfig.health,
    commands: await createManifestCommands(
      normalizedConfig.commands,
      configFile,
      outDir,
    ),
    runtimes: Object.fromEntries(
      Object.entries(normalizedConfig.runtimes ?? {}).map(([name, runtime]) => [
        name,
        { threads: runtime.threads, options: runtime.options },
      ]),
    ),
  }
}

async function createManifestCommands(
  commands: NeemConfig['commands'],
  configFile: string,
  outDir: string,
): Promise<NeemBuildManifestConfig['commands']> {
  if (!commands) return undefined

  const entries = await Promise.all(
    Object.entries(commands).map(async ([name, entry]) => {
      const artifact = await buildArtifact({
        artifact: {
          id: `command:${name}`,
          kind: 'module',
          entry: resolveRequiredRuntimeBuildEntry(configFile, entry),
        },
        owner: { type: 'config' },
        artifactOutDir: resolve(outDir, 'config', 'commands', name),
        outDir,
        minify: true,
      })

      return [name, { file: toManifestPath(outDir, artifact.file) }] as const
    }),
  )

  return Object.fromEntries(entries)
}

async function createManifestLogger(
  logger: NeemConfig['logger'],
  configFile: string,
  outDir: string,
): Promise<NeemBuildManifestLogger | undefined> {
  if (!logger) return undefined
  if (typeof logger === 'string' || logger instanceof URL) {
    const artifact = await buildArtifact({
      artifact: {
        id: 'logger',
        kind: 'module',
        entry: resolveRequiredRuntimeBuildEntry(configFile, logger),
      },
      owner: { type: 'config' },
      artifactOutDir: resolve(outDir, 'config', 'logger'),
      outDir,
      minify: true,
    })
    return { type: 'module', file: toManifestPath(outDir, artifact.file) }
  }

  if (typeof logger === 'function') {
    throw new Error(
      'Logger function loaders are not supported in build config. Use string or URL logger module specifier.',
    )
  }

  if (isLoggerOptions(logger)) {
    return { type: 'options', options: logger }
  }

  throw new Error(
    'Logger instances are not supported in build config. Use pino options, string, or URL logger module specifier.',
  )
}

function isLoggerOptions(input: unknown): input is NeemLoggerOptions {
  return (
    typeof input === 'object' &&
    input !== null &&
    !('child' in input && typeof input.child === 'function')
  )
}

function getRuntimeHostConfig(
  input: NeemRuntimeConfigBase['host'],
): { entry: NeemArtifact['entry']; build?: NeemBuildConfigInput } | undefined {
  if (!input) return undefined
  return typeof input === 'string' || input instanceof URL
    ? { entry: input }
    : input
}

function resolveRuntimeHostEntry(
  importer: string,
  input: NeemRuntimeConfigBase['host'],
): NeemArtifact['entry'] | undefined {
  const host = getRuntimeHostConfig(input)
  return host ? resolveRuntimeBuildEntry(importer, host.entry) : undefined
}

function resolveRuntimeBuildArtifacts(
  importer: string,
  artifacts: readonly NeemArtifact[] | undefined,
): readonly NeemArtifact[] | undefined {
  return artifacts?.map((artifact) => ({
    ...artifact,
    entry: resolveRequiredRuntimeBuildEntry(importer, artifact.entry),
  }))
}

function resolveRequiredRuntimeBuildEntry(
  importer: string,
  entry: NeemArtifact['entry'],
): NeemArtifact['entry'] {
  return resolveRuntimeBuildEntry(importer, entry) ?? entry
}

function resolveRuntimeBuildEntry(
  importer: string,
  entry: NeemArtifact['entry'] | undefined,
): NeemArtifact['entry'] | undefined {
  if (!entry) return undefined
  if (entry instanceof URL) return entry
  if (entry.startsWith('/')) return entry
  if (entry.startsWith('.')) return resolve(dirname(importer), entry)
  return resolveImportFile(importer, entry)
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
    logger.error(`Unknown Neem runtime(s): ${missing.join(', ')}`)
    process.exit(1)
  }
}
