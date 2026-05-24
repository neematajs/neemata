import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import type { NeemConfig } from '../../../packages/neem/src/public/config.ts'
import { createRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'

describe('Neem runtime snapshot', () => {
  it('creates absolute scoped artifacts from manifest-relative paths', () => {
    const outDir = '/tmp/neem-out'
    const manifest: NeemBuildManifest = {
      schemaVersion: 1,
      config: { file: 'config/entry/neem.config.js' },
      runtimes: {
        api: {
          name: 'api',
          entry: {
            id: 'entry',
            kind: 'worker',
            owner: { type: 'runtime', name: 'api' },
            file: 'runtimes/api/entry/api.js',
            outDir: 'runtimes/api/entry',
          },
          artifacts: [],
        },
        jobs: {
          name: 'jobs',
          entry: {
            id: 'entry',
            kind: 'module',
            owner: { type: 'runtime', name: 'jobs' },
            file: 'runtimes/jobs/entry/jobs.js',
            outDir: 'runtimes/jobs/entry',
          },
          artifacts: [
            {
              id: 'job-worker',
              kind: 'worker',
              owner: { type: 'runtime', name: 'jobs' },
              file: 'runtimes/jobs/job-worker/jobs.worker.js',
              outDir: 'runtimes/jobs/job-worker',
            },
          ],
        },
      },
    }

    const snapshot = createRuntimeSnapshot({
      mode: 'development',
      outDir,
      manifest,
      config: { runtimes: {} } as NeemConfig,
    })

    expect(snapshot.artifacts.list()).toHaveLength(3)
    expect(
      snapshot.artifacts
        .scope({ type: 'runtime', name: 'api' })
        .resolve('entry')?.file,
    ).toBe(resolve(outDir, 'runtimes/api/entry/api.js'))
    expect(
      snapshot.artifacts
        .scope({ type: 'runtime', name: 'jobs' })
        .resolve('entry')?.file,
    ).toBe(resolve(outDir, 'runtimes/jobs/entry/jobs.js'))
  })

  it('rejects invalid manifest artifact kinds', () => {
    const manifest: NeemBuildManifest = {
      schemaVersion: 1,
      config: { file: 'config/entry/neem.config.js' },
      runtimes: {
        api: {
          name: 'api',
          entry: {
            id: 'entry',
            kind: 'invalid' as never,
            owner: { type: 'runtime', name: 'api' },
            file: 'runtimes/api/entry/api.js',
            outDir: 'runtimes/api/entry',
          },
          artifacts: [],
        },
      },
    }

    expect(() =>
      createRuntimeSnapshot({
        mode: 'development',
        outDir: '/tmp/neem-out',
        manifest,
        config: { runtimes: {} } as NeemConfig,
      }),
    ).toThrow('Invalid Neem manifest artifact kind [invalid]')
  })

  it('rejects unsupported manifest schema versions', () => {
    const manifest = createManifest()
    manifest.schemaVersion = 2 as never

    expect(() =>
      createRuntimeSnapshot({
        mode: 'development',
        outDir: '/tmp/neem-out',
        manifest,
        config: { runtimes: {} } as NeemConfig,
      }),
    ).toThrow('Unsupported Neem manifest schema version [2]')
  })

  it('rejects manifest paths outside the output directory', () => {
    const manifest = createManifest()
    manifest.runtimes!.api.entry.file = '../api.js'

    expect(() =>
      createRuntimeSnapshot({
        mode: 'development',
        outDir: '/tmp/neem-out',
        manifest,
        config: { runtimes: {} } as NeemConfig,
      }),
    ).toThrow('paths must be relative to output directory')
  })

  it('rejects runtime artifacts owned by another runtime', () => {
    const manifest = createManifest()
    manifest.runtimes!.api.entry.owner = { type: 'runtime', name: 'other' }

    expect(() =>
      createRuntimeSnapshot({
        mode: 'development',
        outDir: '/tmp/neem-out',
        manifest,
        config: { runtimes: {} } as NeemConfig,
      }),
    ).toThrow('entry owner must be runtime [api]')
  })
})

function createManifest(): NeemBuildManifest {
  return {
    schemaVersion: 1,
    config: { file: 'config/entry/neem.config.js' },
    runtimes: {
      api: {
        name: 'api',
        entry: {
          id: 'entry',
          kind: 'worker',
          owner: { type: 'runtime', name: 'api' },
          file: 'runtimes/api/entry/api.js',
          outDir: 'runtimes/api/entry',
        },
        artifacts: [],
      },
    },
  }
}
