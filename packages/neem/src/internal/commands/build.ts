import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { consola } from 'consola'
import { colorize } from 'consola/utils'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemConfig,
  NeemLoggerOptions,
  NeemNormalizedConfig,
} from '../../public/config.ts'
import type {
  NeemBuildManifest,
  NeemBuildManifestConfig,
  NeemBuildManifestLogger,
} from '../build/manifest.ts'
import { normalizeNeemConfig } from '../../public/config.ts'
import {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
  toManifestArtifact,
  toManifestPath,
  writeManifest,
} from '../build/manifest.ts'
import {
  mergePluginRolldownOptions,
  resolvePluginBuildPlans,
} from '../build/plugin-plan.ts'
import { resolveRequiredBuildEntry } from '../build/resolve.ts'
import { buildArtifact } from '../build/rolldown.ts'
import { resolveRuntimeBuildPlans } from '../build/runtime-plan.ts'
import { normalizeSelectedRuntimeNames } from '../build/runtime-selection.ts'
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
  const selectedRuntimes = normalizeSelectedRuntimeNames(options.runtimes)
  const pluginPlans = resolvePluginBuildPlans(configFile, config)
  const pluginRolldown = mergePluginRolldownOptions(pluginPlans)
  const runtimePlans = resolveRuntimeBuildPlans(
    configFile,
    config,
    selectedRuntimes,
    { rolldown: pluginRolldown },
  )
  const runtimeNames = runtimePlans.map((plan) => plan.name)

  logger.start('Building Neem bundle')
  logger.debug(`  config: ${colorize('green', configFile)}`)
  logger.debug(`  outDir: ${colorize('green', outDir)}`)
  logger.debug(
    `  runtimes: ${runtimeNames.map((v) => colorize('cyan', v)).join(', ')}`,
  )

  await cleanNeemOutDir(outDir)
  await mkdir(outDir, { recursive: true })

  logger.info('Bulding Neem runtime:')
  const runtimeArtifacts = await buildRuntimeArtifacts({ outDir })
  const manifestConfig = await createManifestConfig(
    config,
    configFile,
    outDir,
    { runtimes: runtimeNames },
  )

  const manifest: NeemBuildManifest = {
    schemaVersion: NEEM_MANIFEST_SCHEMA_VERSION,
    runtime: {
      entry: 'start.js',
      worker: toManifestPath(outDir, runtimeArtifacts.worker.file),
    },
    plugins: await buildPluginManifestEntries({
      configFile,
      outDir,
      plugins: pluginPlans,
    }),
    config: manifestConfig,
    runtimes: {},
  }

  for (const chunk of runtimeArtifacts.entry.bundle?.output ?? []) {
    logger.debug(`  ${chunk.type}: ${colorize('green', chunk.fileName)}`)
  }

  for (const plan of runtimePlans) {
    const name = plan.name
    logger.start(`Building ${colorize('cyan', name)}:`)

    const entry = await buildArtifact({
      artifact: {
        id: 'entry',
        kind: 'worker',
        entry: plan.worker.entry,
        rolldown: plan.worker.rolldown,
      },
      owner: { type: 'runtime', name },
      outDir,
      emittedArtifacts: plan.worker.artifacts,
      minify: true,
    })

    for (const chunk of entry.bundle?.output ?? []) {
      logger.debug(`  ${chunk.type}: ${colorize('green', chunk.fileName)}`)
    }

    const hostArtifact = plan.host
      ? await buildArtifact({
          artifact: {
            id: 'host',
            kind: 'module',
            entry: plan.host.entry,
            rolldown: plan.host.rolldown,
          },
          owner: { type: 'runtime', name },
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

async function buildPluginManifestEntries(options: {
  configFile: string
  outDir: string
  plugins: ReturnType<typeof resolvePluginBuildPlans>
}): Promise<NeemBuildManifest['plugins']> {
  if (options.plugins.length === 0) return undefined

  return Promise.all(
    options.plugins.map(async (plugin) => {
      const entry = plugin.entry
        ? await buildArtifact({
            artifact: { id: 'plugin', kind: 'module', entry: plugin.entry },
            owner: { type: 'config' },
            artifactOutDir: resolve(
              options.outDir,
              'config',
              'plugins',
              plugin.key,
            ),
            outDir: options.outDir,
            minify: true,
          })
        : undefined

      return {
        name: plugin.name,
        entry: entry
          ? { file: toManifestPath(options.outDir, entry.file) }
          : undefined,
        options: plugin.options,
      }
    }),
  )
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

export async function createManifestConfig(
  config: NeemNormalizedConfig,
  configFile: string,
  outDir: string,
  options: { runtimes?: readonly string[] } = {},
): Promise<NeemBuildManifestConfig> {
  const runtimes = options.runtimes ? new Set(options.runtimes) : undefined

  return {
    logger: await createManifestLogger(config.logger, configFile, outDir),
    proxy: config.proxy,
    health: config.health,
    commands: await createManifestCommands(config.commands, configFile, outDir),
    runtimes: Object.fromEntries(
      Object.entries(config.runtimes ?? {})
        .filter(([name]) => !runtimes || runtimes.has(name))
        .map(([name, runtime]) => [
          name,
          { threads: runtime.threads, options: runtime.options },
        ]),
    ),
  }
}

async function createManifestCommands(
  commands: NeemNormalizedConfig['commands'],
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
          entry: resolveRequiredBuildEntry(configFile, entry),
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
  logger: NeemNormalizedConfig['logger'],
  configFile: string,
  outDir: string,
): Promise<NeemBuildManifestLogger | undefined> {
  if (!logger) return undefined
  if (typeof logger === 'string' || logger instanceof URL) {
    const artifact = await buildArtifact({
      artifact: {
        id: 'logger',
        kind: 'module',
        entry: resolveRequiredBuildEntry(configFile, logger),
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
