import { resolve } from 'node:path'

import type { Logger } from '@nmtjs/core'

import type { NeemMode } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import {
  createRuntimeConfigFromManifest,
  NEEM_MANIFEST_FILE,
  readManifest,
  selectManifestRuntimes,
} from '../build/manifest.ts'
import { createNeemDefaultLogger } from './logger.ts'
import { createRuntimeSnapshot } from './snapshot.ts'
import { importDefault } from './utils.ts'

export type NeemBuiltSnapshotLoadOptions = {
  cwd?: string
  outDir?: string
  mode: NeemMode
  runtimes?: readonly string[]
  runtimeWorkerEntry?: string | URL
}

export async function loadBuiltRuntimeSnapshot(
  options: NeemBuiltSnapshotLoadOptions,
): Promise<NeemRuntimeSnapshot> {
  const cwd = options.cwd ?? process.cwd()
  const outDir = resolve(cwd, options.outDir ?? 'dist')
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  const manifest = selectManifestRuntimes(
    await readManifest(manifestFile),
    options.runtimes,
  )
  const logger = await resolveManifestLogger(manifest, outDir, options.mode)
  const config = createRuntimeConfigFromManifest(manifest)

  return createRuntimeSnapshot({
    mode: options.mode,
    outDir,
    manifestFile,
    manifest,
    config,
    configFile: manifestFile,
    runtimeWorkerEntry: options.runtimeWorkerEntry,
    logger,
  })
}

async function resolveManifestLogger(
  manifest: NeemBuildManifest,
  outDir: string,
  mode: NeemMode,
): Promise<Logger | undefined> {
  const logger = manifest.config.logger
  if (!logger) return undefined
  if (logger.type === 'options') {
    return createNeemDefaultLogger(mode, logger.options)
  }

  return importDefault<Logger>(resolve(outDir, logger.file))
}
