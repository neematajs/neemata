import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NEEM_MANIFEST_FILE } from '../../../packages/neem/src/internal/build/manifest.ts'
import { loadBuiltRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot-loader.ts'

const tempDirs: string[] = []

describe('Neem built snapshot loader', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('loads manifest config into a runtime snapshot', async () => {
    const outDir = await mkdtemp(resolve(tmpdir(), 'neem-snapshot-'))
    tempDirs.push(outDir)

    await writeFile(
      resolve(outDir, NEEM_MANIFEST_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        config: { runtimes: {} },
        runtimes: {},
      })}\n`,
    )

    const snapshot = await loadBuiltRuntimeSnapshot({
      mode: 'production',
      outDir,
    })

    expect(snapshot.mode).toBe('production')
    expect(snapshot.outDir).toBe(outDir)
    expect(snapshot.config.runtimes).toEqual({})
    expect(snapshot.artifacts.list()).toEqual([])
  })
})
