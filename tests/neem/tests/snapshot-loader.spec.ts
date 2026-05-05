import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NEEM_MANIFEST_FILE } from '../../../packages/neem/src/internal/manifest.ts'
import { loadBuiltRuntimeSnapshot } from '../../../packages/neem/src/internal/snapshot-loader.ts'

const tempDirs: string[] = []

describe('Neem built snapshot loader', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('loads manifest and compiled config into a runtime snapshot', async () => {
    const outDir = await mkdtemp(resolve(tmpdir(), 'neem-snapshot-'))
    tempDirs.push(outDir)

    await mkdir(resolve(outDir, 'config/entry'), { recursive: true })
    await writeFile(
      resolve(outDir, 'config/entry/neem.config.js'),
      'export default { apps: {}, plugins: [] };\n',
    )
    await writeFile(
      resolve(outDir, NEEM_MANIFEST_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        config: { file: 'config/entry/neem.config.js' },
        apps: {},
        plugins: [],
      })}\n`,
    )

    const snapshot = await loadBuiltRuntimeSnapshot({
      mode: 'production',
      outDir,
    })

    expect(snapshot.mode).toBe('production')
    expect(snapshot.outDir).toBe(outDir)
    expect(snapshot.config.apps).toEqual({})
    expect(snapshot.artifacts.list()).toEqual([])
  })
})
