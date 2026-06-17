import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { MANIFEST_FILE } from '../manifest/manifest.ts'

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

  const configRelativePath = relative(outDir, configDir)
  if (
    configRelativePath !== '' &&
    configRelativePath !== '..' &&
    !configRelativePath.startsWith(`..${sep}`) &&
    !isAbsolute(configRelativePath)
  ) {
    throw new Error(
      `Neem output directory must not contain the config directory [${options.outDir}]`,
    )
  }
}

export async function cleanNeemOutDir(outDir: string): Promise<void> {
  await Promise.all([
    rm(resolve(outDir, 'start.js'), { force: true }),
    rm(resolve(outDir, 'start.js.map'), { force: true }),
    rm(resolve(outDir, 'runtime'), { recursive: true, force: true }),
    rm(resolve(outDir, 'runtimes'), { recursive: true, force: true }),
    rm(resolve(outDir, 'config'), { recursive: true, force: true }),
    rm(resolve(outDir, MANIFEST_FILE), { force: true }),
  ])
}
