import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Logger } from '@nmtjs/core'

import type { NeemConfig } from '../../public/config.ts'
import type { NeemMode } from '../../public/runtime.ts'
import type { NeemBuildManifest } from '../build/manifest.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'
import { createNeemDefaultLogger } from './logger.ts'
import { createRuntimeSnapshot } from './snapshot.ts'

type ManifestParser = (value: unknown) => NeemBuildManifest

const manifestParsers = {
  [NEEM_MANIFEST_SCHEMA_VERSION]: parseManifestV1,
} satisfies Record<number, ManifestParser>

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
  const manifest = filterManifestRuntimes(
    await readManifest(manifestFile),
    options.runtimes,
  )
  const logger = await resolveManifestLogger(manifest, outDir, options.mode)
  const config = createConfigFromManifest(manifest, logger)

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
): Promise<Logger> {
  const logger = manifest.config.logger
  if (!logger) return createNeemDefaultLogger(mode)
  if (logger.type === 'options') {
    return createNeemDefaultLogger(mode, logger.options)
  }

  return (await import(pathToFileURL(resolve(outDir, logger.file)).href))
    .default as Logger
}

function createConfigFromManifest(
  manifest: NeemBuildManifest,
  logger: Logger,
): NeemConfig {
  return {
    proxy: manifest.config.proxy,
    health: manifest.config.health,
    commands: manifest.config.commands
      ? Object.fromEntries(
          Object.keys(manifest.config.commands).map((name) => [name, '']),
        )
      : undefined,
    runtimes: Object.fromEntries(
      Object.entries(manifest.config.runtimes).map(([name, runtime]) => [
        name,
        { entry: '', threads: runtime.threads, options: runtime.options },
      ]),
    ),
  }
}

function filterManifestRuntimes(
  manifest: NeemBuildManifest,
  runtimes: readonly string[] | undefined,
): NeemBuildManifest {
  const selected = runtimes?.map((runtime) => runtime.trim()).filter(Boolean)
  if (!selected || selected.length === 0) return manifest

  const names = [...new Set(selected)]
  const available = Object.keys(manifest.runtimes ?? {})
  const missing = names.filter((name) => !available.includes(name))
  if (missing.length > 0) {
    throw new Error(`Unknown Neem runtime(s): ${missing.join(', ')}`)
  }

  return {
    ...manifest,
    runtimes: Object.fromEntries(
      Object.entries(manifest.runtimes ?? {}).filter(([name]) =>
        names.includes(name),
      ),
    ),
  }
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
