import { describe, expect, it } from 'vitest'

import type { NeemResolvedArtifact } from '../../../packages/neem/src/public/artifact.ts'
import { createNeemArtifactRegistry } from '../../../packages/neem/src/internal/runtime/artifact-registry.ts'

describe('Neem artifact registry', () => {
  it('resolves duplicate artifact ids through owner-scoped registries', () => {
    const artifacts: NeemResolvedArtifact[] = [
      {
        id: 'entry',
        kind: 'module',
        owner: { type: 'runtime', name: 'api' },
        file: '/out/runtimes/api/entry.js',
        outDir: '/out/runtimes/api',
      },
      {
        id: 'entry',
        kind: 'module',
        owner: { type: 'runtime', name: 'jobs' },
        file: '/out/runtimes/jobs/entry.js',
        outDir: '/out/runtimes/jobs',
      },
      {
        id: 'job-worker',
        kind: 'worker',
        owner: { type: 'runtime', name: 'jobs' },
        file: '/out/runtimes/jobs/job-worker.js',
        outDir: '/out/runtimes/jobs',
      },
    ]

    const registry = createNeemArtifactRegistry(artifacts)

    expect(registry.resolve('entry')?.file).toBe('/out/runtimes/api/entry.js')
    expect(
      registry.resolveFor({ type: 'runtime', name: 'jobs' }, 'entry')?.file,
    ).toBe('/out/runtimes/jobs/entry.js')
    expect(
      registry.scope({ type: 'runtime', name: 'api' }).resolve('entry')?.file,
    ).toBe('/out/runtimes/api/entry.js')
    expect(
      registry.scope({ type: 'runtime', name: 'jobs' }).resolve('job-worker')
        ?.file,
    ).toBe('/out/runtimes/jobs/job-worker.js')
    expect(
      registry.scope({ type: 'runtime', name: 'api' }).resolve('job-worker'),
    ).toBeUndefined()
  })
})
