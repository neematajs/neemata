import { basename, dirname, extname, resolve } from 'node:path'

import type { NeemConfig } from '../../shared/types.ts'
import { importDefault } from '../utils.ts'

const DEFAULT_OUT_DIR = 'dist'

// `--outDir` is a CLI argument and resolves from cwd. Config `outDir` resolves
// from the config file like runtime entries, so a config builds to the same
// place from any working directory.
export function resolveBuildOutDir(options: {
  cwd: string
  configFile: string
  config: Pick<NeemConfig, 'outDir'>
  outDir?: string
}): string {
  if (options.outDir !== undefined) return resolve(options.cwd, options.outDir)
  return resolve(
    dirname(options.configFile),
    options.config.outDir ?? DEFAULT_OUT_DIR,
  )
}

// Keyed by config file name so configs sharing a directory never clean each
// other's output. It stays outside the build output, which deployments publish.
export function resolveDevOutDir(options: {
  cwd: string
  configFile: string
  outDir?: string
}): string {
  if (options.outDir !== undefined) return resolve(options.cwd, options.outDir)
  const { configFile } = options
  return resolve(
    dirname(configFile),
    '.neem',
    basename(configFile, extname(configFile)),
  )
}

// Start evaluates source config only when asked to, so deployed output starts
// without it.
export async function resolveStartOutDir(options: {
  cwd: string
  config?: string
  outDir?: string
}): Promise<string> {
  if (options.outDir !== undefined) return resolve(options.cwd, options.outDir)
  if (options.config === undefined) {
    return resolve(options.cwd, DEFAULT_OUT_DIR)
  }
  const configFile = resolve(options.cwd, options.config)
  const config = await importDefault<NeemConfig>(configFile)
  return resolveBuildOutDir({ cwd: options.cwd, configFile, config })
}
