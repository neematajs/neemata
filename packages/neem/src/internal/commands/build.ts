import { dirname, resolve } from 'node:path'

import { consola } from 'consola'
import { colorize } from 'consola/utils'

import type { NeemConfig } from '../../shared/types.ts'
import type { Manifest } from '../manifest/manifest.ts'
import { assertSafeNeemOutDir, cleanNeemOutDir } from '../build/clean.ts'
import { compileGraph } from '../build/compiler.ts'
import { resolveNeemRuntimeDeclarations } from '../build/declarations.ts'
import { createBuildGraph } from '../build/graph.ts'
import { createManifest, writeManifest } from '../manifest/manifest.ts'
import { importDefault } from '../shared/utils.ts'

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
  const config = await importDefault<NeemConfig>(configFile, {
    cacheBust: true,
  })
  const outDir = resolve(cwd, options.outDir ?? config.outDir ?? 'dist')

  logger.start('Building Neem bundle')
  logger.debug(`  config: ${colorize('green', configFile)}`)
  logger.debug(`  outDir: ${colorize('green', outDir)}`)

  const resolvedConfig = await resolveNeemRuntimeDeclarations(
    configFile,
    config,
  )
  const graph = createBuildGraph({
    configFile,
    outDir,
    config: resolvedConfig,
    runtimes: options.runtimes,
  })

  assertSafeNeemOutDir({ outDir, configDir: dirname(configFile) })
  await cleanNeemOutDir(outDir)
  const compiled = await compileGraph(graph)
  const manifest = createManifest(compiled)
  const manifestFile = await writeManifest(outDir, manifest)

  logger.success('Neem build complete')
  logger.info(`manifest: ${colorize('green', manifestFile)}`)
  logger.info(
    `runtimes: ${colorize('green', Object.keys(manifest.runtimes).length)}`,
  )

  return { configFile, outDir, manifestFile, manifest }
}
