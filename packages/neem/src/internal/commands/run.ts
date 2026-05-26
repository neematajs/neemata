import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { CommandDef } from 'citty'
import { runCommand } from 'citty'

import type { NeemBuildManifest } from '../build/manifest.ts'
import {
  NEEM_MANIFEST_FILE,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from '../build/manifest.ts'

export type NeemRunCommandOptions = {
  cwd?: string
  outDir?: string
  command: string
  args?: readonly string[]
}

export async function runNeemCommand(
  options: NeemRunCommandOptions,
): Promise<unknown> {
  const cwd = options.cwd ?? process.cwd()
  const outDir = resolve(cwd, options.outDir ?? 'dist')
  const manifestFile = resolve(outDir, NEEM_MANIFEST_FILE)
  const manifest = await readManifest(manifestFile)
  const command = manifest.config.commands?.[options.command]

  if (!command) {
    throw new Error(`Unknown Neem command [${options.command}]`)
  }

  const commandFile = resolve(outDir, command.file)
  const module = await import(pathToFileURL(commandFile).href)
  const commandDef = module.default as CommandDef | undefined

  if (!commandDef || typeof commandDef !== 'object') {
    throw new Error(
      `Neem command [${options.command}] must default-export a citty command`,
    )
  }

  return (await runCommand(commandDef, { rawArgs: [...(options.args ?? [])] }))
    .result
}

async function readManifest(manifestFile: string): Promise<NeemBuildManifest> {
  const manifest = JSON.parse(
    await readFile(manifestFile, 'utf8'),
  ) as NeemBuildManifest
  if (manifest.schemaVersion !== NEEM_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Neem manifest schema version [${String(manifest.schemaVersion)}] at [${manifestFile}]`,
    )
  }

  return manifest
}
