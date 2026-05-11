import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import type { NeemConfig } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'
import { resolveNeemConfigLogger } from './logger.ts'
import { createRuntimeSnapshot } from './snapshot.ts'
import { importDefault } from './utils.ts'

type ManifestParser = (value: unknown) => NeemBuildManifest

const manifestParsers = {
  [NEEM_MANIFEST_SCHEMA_VERSION]: parseManifestV1,
} satisfies Record<number, ManifestParser>

export type NeemBuiltSnapshotLoadOptions = {
  cwd?: string
  outDir?: string
  mode: NeemMode
}

export async function loadBuiltRuntimeSnapshot(
  options: NeemBuiltSnapshotLoadOptions,
): Promise<NeemRuntimeSnapshot> {
  const cwd = options.cwd ?? process.cwd()
  const outDir = resolve(cwd, options.outDir ?? 'dist')
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  const manifest = await readManifest(manifestFile)
  const config = await importDefault<NeemConfig>(
    resolve(outDir, manifest.config.file),
  )
  const logger = await resolveNeemConfigLogger(config)

  return createRuntimeSnapshot({
    mode: options.mode,
    outDir,
    manifestFile,
    manifest,
    config,
    configFile: resolve(outDir, manifest.config.file),
    logger,
  })
}

async function readManifest(manifestFile: string): Promise<NeemBuildManifest> {
  const raw = JSON.parse(
    await readFile(manifestFile, 'utf8'),
  ) as NeemBuildManifest
  const parser = manifestParsers[raw.schemaVersion]
  if (!parser) {
    throw new Error(
      `Unsupported Neem manifest schema version [${String(raw.schemaVersion)}] at [${manifestFile}]`,
    )
  }

  return parser(raw)
}

function parseManifestV1(value: unknown): NeemBuildManifest {
  return value as NeemBuildManifest
}
