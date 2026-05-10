import { describe, expect, it } from 'vitest'

import type { NeemResolvedArtifact } from '../../../packages/neem/src/public/artifact.ts'
import { createNeemArtifactRegistry } from '../../../packages/neem/src/internal/runtime/artifact-registry.ts'

describe('Neem artifact registry', () => {
  it('resolves duplicate artifact ids through owner-scoped registries', () => {
    const artifacts: NeemResolvedArtifact[] = [
      {
        id: 'entry',
        kind: 'module',
        owner: { type: 'app', name: 'api' },
        file: '/out/apps/api/entry.js',
        outDir: '/out/apps/api',
      },
      {
        id: 'entry',
        kind: 'module',
        owner: { type: 'plugin', name: 'jobs', instanceId: 0 },
        file: '/out/plugins/jobs/entry.js',
        outDir: '/out/plugins/jobs',
      },
      {
        id: 'job-worker',
        kind: 'worker',
        owner: { type: 'plugin', name: 'jobs', instanceId: 0 },
        file: '/out/plugins/jobs/job-worker.js',
        outDir: '/out/plugins/jobs',
      },
    ]

    const registry = createNeemArtifactRegistry(artifacts)

    expect(registry.resolve('entry')?.file).toBe('/out/apps/api/entry.js')
    expect(
      registry.resolveFor(
        { type: 'plugin', name: 'jobs', instanceId: 0 },
        'entry',
      )?.file,
    ).toBe('/out/plugins/jobs/entry.js')
    expect(
      registry.scope({ type: 'app', name: 'api' }).resolve('entry')?.file,
    ).toBe('/out/apps/api/entry.js')
    expect(
      registry
        .scope({ type: 'plugin', name: 'jobs', instanceId: 0 })
        .resolve('job-worker')?.file,
    ).toBe('/out/plugins/jobs/job-worker.js')
  })
})
