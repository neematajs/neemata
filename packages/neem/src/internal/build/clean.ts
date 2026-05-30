import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { MANIFEST_FILE } from '../manifest/manifest.ts'

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
