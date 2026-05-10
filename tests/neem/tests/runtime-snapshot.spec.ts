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
      apps: {
        api: {
          name: 'api',
          entry: {
            id: 'entry',
            kind: 'module',
            owner: { type: 'app', name: 'api' },
            file: 'apps/api/entry/api.js',
            outDir: 'apps/api/entry',
          },
        },
      },
      plugins: [
        {
          index: 0,
          name: 'jobs',
          entry: {
            id: 'entry',
            kind: 'module',
            owner: { type: 'plugin', name: 'jobs', instanceId: 0 },
            file: 'plugins/0-jobs/entry/jobs.js',
            outDir: 'plugins/0-jobs/entry',
          },
          artifacts: [
            {
              id: 'job-worker',
              kind: 'worker',
              owner: { type: 'plugin', name: 'jobs', instanceId: 0 },
              file: 'plugins/0-jobs/job-worker/jobs.worker.js',
              outDir: 'plugins/0-jobs/job-worker',
            },
          ],
        },
      ],
    }

    const snapshot = createRuntimeSnapshot({
      mode: 'development',
      outDir,
      manifest,
      config: { apps: {} } as NeemConfig,
    })

    expect(snapshot.artifacts.list()).toHaveLength(3)
    expect(
      snapshot.artifacts.scope({ type: 'app', name: 'api' }).resolve('entry')
        ?.file,
    ).toBe(resolve(outDir, 'apps/api/entry/api.js'))
    expect(
      snapshot.artifacts
        .scope({ type: 'plugin', name: 'jobs', instanceId: 0 })
        .resolve('entry')?.file,
    ).toBe(resolve(outDir, 'plugins/0-jobs/entry/jobs.js'))
  })
})
