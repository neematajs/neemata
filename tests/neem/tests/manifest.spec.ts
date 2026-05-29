import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import {
  createRuntimeConfigFromManifest,
  NEEM_MANIFEST_FILE,
  readManifest,
  selectManifestRuntimes,
  toManifestPath,
} from '../../../packages/neem/src/internal/build/manifest.ts'

const tempDirs: string[] = []

describe('Neem build manifest helpers', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('selects runtimes in manifest artifacts and manifest config together', () => {
    const manifest = createManifest()

    const selected = selectManifestRuntimes(manifest, [' jobs ', 'api', 'api'])

    expect(Object.keys(selected.runtimes ?? {})).toEqual(['api', 'jobs'])
    expect(Object.keys(selected.config.runtimes)).toEqual(['api', 'jobs'])
    expect(selected.config.runtimes.admin).toBeUndefined()
  })

  it('rejects selected runtimes missing from manifest artifacts', () => {
    expect(() => selectManifestRuntimes(createManifest(), ['missing'])).toThrow(
      'Unknown Neem runtime(s): missing',
    )
  })

  it('projects manifest config into runtime config', () => {
    const config = createRuntimeConfigFromManifest(createManifest())

    expect(config.proxy).toEqual({ hostname: '127.0.0.1', port: 3000 })
    expect(config.health).toEqual({ port: 3100 })
    expect(config.commands).toEqual({ seed: '' })
    expect(config.runtimes).toEqual({
      api: { worker: { entry: '' }, threads: 2, options: { label: 'api' } },
      jobs: {
        worker: { entry: '' },
        threads: [{ worker: true }],
        options: { label: 'jobs' },
      },
      admin: { worker: { entry: '' }, threads: undefined, options: undefined },
    })
  })

  it('reads and validates manifest paths from disk', async () => {
    const outDir = await mkdtemp(resolve(tmpdir(), 'neem-manifest-'))
    tempDirs.push(outDir)
    const manifest = createManifest({
      config: {
        ...createManifest().config,
        commands: { seed: { file: '/tmp/seed.js' } },
      },
    })

    await writeFile(
      resolve(outDir, NEEM_MANIFEST_FILE),
      `${JSON.stringify(manifest)}\n`,
    )

    await expect(
      readManifest(resolve(outDir, NEEM_MANIFEST_FILE)),
    ).rejects.toThrow('Invalid Neem manifest path [config.commands.seed.file]')
  })

  it('converts absolute files into manifest-relative paths', () => {
    expect(
      toManifestPath('/tmp/neem/dist', '/tmp/neem/dist/runtime/app.js'),
    ).toBe('runtime/app.js')
  })
})

function createManifest(
  overrides: Partial<NeemBuildManifest> = {},
): NeemBuildManifest {
  return {
    schemaVersion: 1,
    runtime: { entry: 'start.js', worker: 'runtime/worker-entry.js' },
    config: {
      proxy: { hostname: '127.0.0.1', port: 3000 },
      health: { port: 3100 },
      commands: { seed: { file: 'config/commands/seed.js' } },
      runtimes: {
        api: { threads: 2, options: { label: 'api' } },
        jobs: { threads: [{ worker: true }], options: { label: 'jobs' } },
        admin: {},
      },
    },
    runtimes: {
      api: {
        name: 'api',
        entry: {
          id: 'entry',
          kind: 'worker',
          owner: { type: 'runtime', name: 'api' },
          file: 'runtimes/api/entry.js',
          outDir: 'runtimes/api',
        },
        artifacts: [],
      },
      jobs: {
        name: 'jobs',
        entry: {
          id: 'entry',
          kind: 'worker',
          owner: { type: 'runtime', name: 'jobs' },
          file: 'runtimes/jobs/entry.js',
          outDir: 'runtimes/jobs',
        },
        artifacts: [],
      },
    },
    ...overrides,
  }
}
