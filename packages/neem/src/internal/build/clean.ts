import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { MANIFEST_FILE, OUT_LAYOUT } from '../layout.ts'

export function assertSafeNeemOutDir(options: {
  outDir: string
  configDir: string
}): void {
  const outDir = resolve(options.outDir)
  const configDir = resolve(options.configDir)

  if (outDir === configDir) {
    throw new Error(
      `Neem output directory must not be the config directory [${options.outDir}]`,
    )
  }

  if (isPathInside(configDir, outDir)) {
    throw new Error(
      `Neem output directory must not contain the config directory [${options.outDir}]`,
    )
  }
}

export async function cleanNeemOutDir(outDir: string): Promise<void> {
  const { startEntry, runtime, runtimeStarts, config } = OUT_LAYOUT
  await Promise.all([
    rm(resolve(outDir, startEntry), { force: true }),
    rm(resolve(outDir, `${startEntry}.map`), { force: true }),
    rm(resolve(outDir, runtime), { recursive: true, force: true }),
    rm(resolve(outDir, runtimeStarts), { recursive: true, force: true }),
    rm(resolve(outDir, config), { recursive: true, force: true }),
    rm(resolve(outDir, MANIFEST_FILE), { force: true }),
  ])
}

function isPathInside(child: string, parent: string): boolean {
  const path = relative(parent, child)
  return (
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  )
}
