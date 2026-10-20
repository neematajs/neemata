import { dirname, resolve } from 'node:path'

import { consola } from 'consola'
import { colorize } from 'consola/utils'

import type { NeemBuildCommand, NeemConfig } from '../../shared/types.ts'
import type { Manifest } from '../manifest/manifest.ts'
import { assertSafeNeemOutDir, cleanNeemOutDir } from '../build/clean.ts'
import { compileGraph } from '../build/compiler.ts'
import { resolveNeemRuntimeDeclarations } from '../build/declarations.ts'
import { createBuildGraph } from '../build/graph.ts'
import { createManifest, writeManifest } from '../manifest/manifest.ts'
import { importDefault } from '../utils.ts'
import { resolveBuildOutDir } from './out-dir.ts'

export type NeemBuildOptions = {
  config?: string
  outDir?: string
  cwd?: string
  runtimes?: readonly string[]
  /**
   * `preview` builds the same production artifacts with source maps forced
   * on, and tells plugins that opt into the build context.
   */
  command?: Exclude<NeemBuildCommand, 'dev'>
}

export type NeemBuildResult = {
  configFile: string
  outDir: string
  manifestFile: string
  manifest: Manifest
}

const logger = consola.create({
  level: process.env.NODE_ENV === 'test' ? 0 : 4,
})

export async function buildNeem(
  options: NeemBuildOptions = {},
): Promise<NeemBuildResult> {
  const cwd = options.cwd ?? process.cwd()
  const configFile = resolve(cwd, options.config ?? 'neem.config.ts')
  const config = await importDefault<NeemConfig>(configFile)
  const outDir = resolveBuildOutDir({
    cwd,
    configFile,
    config,
    outDir: options.outDir,
  })

  const command = options.command ?? 'build'
  logger.start(
    command === 'preview' ? 'Building Neem preview' : 'Building Neem bundle',
  )
  logger.debug(`  config: ${colorize('green', configFile)}`)
  logger.debug(`  outDir: ${colorize('green', outDir)}`)

  const resolvedConfig = await resolveNeemRuntimeDeclarations(
    configFile,
    config,
  )
  const graph = createBuildGraph({
    configFile,
    outDir,
    // Preview exists to inspect production behavior with mapped stacks, so
    // a config that disables or hides maps for deployment does not apply.
    config:
      command === 'preview'
        ? {
            ...resolvedConfig,
            build: { ...resolvedConfig.build, sourcemap: true },
          }
        : resolvedConfig,
    runtimes: options.runtimes,
  })

  assertSafeNeemOutDir({ outDir, configDir: dirname(configFile) })
  await cleanNeemOutDir(outDir)
  const compiled = await compileGraph(graph, command)
  const manifest = createManifest(compiled)
  const manifestFile = await writeManifest(outDir, manifest)

  logger.success('Neem build complete')
  logger.info(`manifest: ${colorize('green', manifestFile)}`)
  logger.info(
    `runtimes: ${colorize('green', Object.keys(manifest.runtimes).length)}`,
  )

  return { configFile, outDir, manifestFile, manifest }
}
