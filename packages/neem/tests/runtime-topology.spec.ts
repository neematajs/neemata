import { describe, expect, it } from 'vitest'

import type { RuntimeSnapshot } from '../src/internal/manifest/snapshot.ts'
import type { NeemResolvedArtifact } from '../src/public/artifact.ts'
import { resolveThreadTopology } from '../src/internal/host/runtime.ts'
import { createArtifactRegistry } from '../src/internal/manifest/artifacts.ts'
import { createDefaultLogger } from '../src/internal/shared/logger.ts'

describe('runtime thread topology', () => {
  it('creates worker plans from array planner output', () => {
    const snapshot = createSnapshot()

    expect(
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        plan: { workers: [{ label: 'one' }, { label: 'two' }] },
      }),
    ).toEqual([
      {
        name: 'api:0',
        artifact: artifact('worker', 'api', '/out/api-worker.js'),
        data: { label: 'one' },
      },
      {
        name: 'api:1',
        artifact: artifact('worker', 'api', '/out/api-worker.js'),
        data: { label: 'two' },
      },
    ])
  })

  it('creates worker plans from grouped planner output', () => {
    const snapshot = createSnapshot()

    expect(
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        plan: {
          workers: { read: [{ pool: 'read' }], write: [{ pool: 'write' }] },
        },
      }),
    ).toEqual([
      {
        name: 'api:read:0',
        artifact: artifact('worker', 'api', '/out/api-worker.js'),
        data: { pool: 'read' },
      },
      {
        name: 'api:write:0',
        artifact: artifact('worker', 'api', '/out/api-worker.js'),
        data: { pool: 'write' },
      },
    ])
  })

  it('allows host-only runtimes when planner returns no workers', () => {
    const snapshot = createSnapshot({
      artifacts: [artifact('host', 'scheduler', '/out/scheduler-host.js')],
    })

    expect(
      resolveThreadTopology({
        snapshot,
        runtimeName: 'scheduler',
        plan: { workers: [] },
      }),
    ).toEqual([])
  })

  it('rejects planned workers without a worker artifact', () => {
    const snapshot = createSnapshot({
      artifacts: [artifact('host', 'scheduler', '/out/scheduler-host.js')],
    })

    expect(() =>
      resolveThreadTopology({
        snapshot,
        runtimeName: 'scheduler',
        plan: { workers: [{ pool: 'default' }] },
      }),
    ).toThrow('planned workers but has no worker artifact')
  })

  it('rejects worker data that cannot cross worker_threads', () => {
    const snapshot = createSnapshot()

    expect(() =>
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        plan: { workers: [() => undefined] },
      }),
    ).toThrow('data must be structured-cloneable')
  })

  it('rejects invalid planner workers output', () => {
    const snapshot = createSnapshot()

    expect(() =>
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        plan: { workers: { invalid: true } as never },
      }),
    ).toThrow('workers must be an array or record of arrays')
  })
})

function createSnapshot(
  options: { artifacts?: NeemResolvedArtifact[] } = {},
): RuntimeSnapshot {
  const artifacts = options.artifacts ?? [
    artifact('worker', 'api', '/out/api-worker.js'),
    artifact('host', 'api', '/out/api-host.js'),
    artifact('planner', 'api', '/out/api-planner.js'),
  ]

  return {
    mode: 'development',
    outDir: '/out',
    manifest: {
      schemaVersion: 1,
      runtime: {
        entry: 'runtime/start.js',
        start: artifact('start', 'start', '/out/runtime/start.js'),
        worker: artifact('worker-entry', 'worker', '/out/runtime/worker.js'),
      },
      config: { runtimes: { api: {}, scheduler: {} } },
      runtimes: {
        api: {
          name: 'api',
          worker: artifact('worker', 'api', '/out/api-worker.js'),
          host: artifact('host', 'api', '/out/api-host.js'),
          planner: artifact('planner', 'api', '/out/api-planner.js'),
        },
        scheduler: {
          name: 'scheduler',
          host: artifact('host', 'scheduler', '/out/scheduler-host.js'),
          planner: artifact(
            'planner',
            'scheduler',
            '/out/scheduler-planner.js',
          ),
        },
      },
    },
    config: { runtimes: { api: {}, scheduler: {} } },
    logger: createDefaultLogger('development'),
    artifacts: createArtifactRegistry(artifacts),
    workerEntry: '/out/runtime/worker.js',
  }
}

function artifact(
  id: string,
  runtimeName: string,
  file: string,
): NeemResolvedArtifact {
  return {
    id,
    kind: id === 'worker' || id === 'worker-entry' ? 'worker' : 'module',
    owner: { type: 'runtime', name: runtimeName },
    file,
    outDir: file.replace(/\/[^/]+$/, ''),
  }
}
