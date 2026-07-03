import { describe, expect, it } from 'vitest'

import type { NeemResolvedArtifact } from '../../src/shared/types.ts'
import { createArtifactRegistry } from '../../src/internal/manifest/artifacts.ts'

describe('createArtifactRegistry', () => {
  it('resolves first global id and scoped runtime artifacts independently', () => {
    const apiEntry = artifact('entry', 'api', '/out/api.js')
    const jobsEntry = artifact('entry', 'jobs', '/out/jobs.js')
    const jobsSchema = artifact('schema', 'jobs', '/out/schema.js')
    const registry = createArtifactRegistry([apiEntry, jobsEntry, jobsSchema])

    expect(registry.resolve('entry')).toBe(apiEntry)
    expect(registry.resolveFor({ type: 'runtime', name: 'api' }, 'entry')).toBe(
      apiEntry,
    )
    expect(
      registry.resolveFor({ type: 'runtime', name: 'jobs' }, 'entry'),
    ).toBe(jobsEntry)
    expect(
      registry.resolveFor({ type: 'runtime', name: 'jobs' }, 'schema'),
    ).toBe(jobsSchema)
    expect(registry.list()).toEqual([apiEntry, jobsEntry, jobsSchema])
  })
})

function artifact(
  id: string,
  runtimeName: string,
  file: string,
): NeemResolvedArtifact {
  return {
    id,
    kind: 'worker',
    owner: { type: 'runtime', name: runtimeName },
    file,
    outDir: file.replace(/\/[^/]+$/, ''),
  }
}
