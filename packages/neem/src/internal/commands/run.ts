import { resolve } from 'node:path'

import type { CommandDef } from 'citty'
import { runCommand } from 'citty'

import { NEEM_MANIFEST_FILE, readManifest } from '../build/manifest.ts'
import { importDefault } from '../runtime/utils.ts'

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

  const commandDef = await importDefault<CommandDef | undefined>(
    resolve(outDir, command.file),
  )

  if (!commandDef || typeof commandDef !== 'object') {
    throw new Error(
      `Neem command [${options.command}] must default-export a citty command`,
    )
  }

  return (await runCommand(commandDef, { rawArgs: [...(options.args ?? [])] }))
    .result
}
