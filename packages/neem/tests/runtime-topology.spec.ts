import { describe, expect, it } from 'vitest'

import type { RuntimeSnapshot } from '../src/internal/manifest/snapshot.ts'
import type { NeemResolvedArtifact } from '../src/public/artifact.ts'
import {
  createDefaultThreadPlans,
  resolveThreadTopology,
} from '../src/internal/host/runtime.ts'
import { createArtifactRegistry } from '../src/internal/manifest/artifacts.ts'
import { createDefaultLogger } from '../src/internal/shared/logger.ts'

describe('runtime thread topology', () => {
  it('creates default thread plans from numeric and array runtime config', () => {
    const snapshot = createSnapshot({
      configRuntimes: {
        api: { threads: 2 },
        jobs: { threads: [{ queue: 'high' }, { queue: 'low' }] },
      },
    })

    expect(createDefaultThreadPlans(snapshot, 'api')).toEqual([
      { name: 'api:0', artifact: 'entry', data: {} },
      { name: 'api:1', artifact: 'entry', data: {} },
    ])
    expect(createDefaultThreadPlans(snapshot, 'jobs')).toEqual([
      { name: 'jobs:0', artifact: 'entry', data: { queue: 'high' } },
      { name: 'jobs:1', artifact: 'entry', data: { queue: 'low' } },
    ])
  })

  it('allows zero-thread host runtimes and rejects zero-thread worker-only runtimes', () => {
    const snapshot = createSnapshot({ configRuntimes: { api: { threads: 0 } } })

    expect(
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        requireThreads: false,
        defaultThreads: [],
        plans: [],
      }),
    ).toEqual([])
    expect(() =>
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        requireThreads: true,
        defaultThreads: [],
        plans: [],
      }),
    ).toThrow('must plan at least one thread')
  })

  it('expands counted host plans and resolves runtime-scoped artifacts', () => {
    const snapshot = createSnapshot({
      artifacts: [
        artifact('entry', 'api', '/out/api-entry.js'),
        artifact('worker-alt', 'api', '/out/api-alt.js'),
      ],
    })

    expect(
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        requireThreads: true,
        defaultThreads: [],
        plans: [
          {
            name: 'worker',
            artifact: 'worker-alt',
            count: 2,
            data: { role: 'read' },
          },
        ],
      }),
    ).toEqual([
      {
        name: 'worker:0',
        artifact: artifact('worker-alt', 'api', '/out/api-alt.js'),
        data: { role: 'read' },
      },
      {
        name: 'worker:1',
        artifact: artifact('worker-alt', 'api', '/out/api-alt.js'),
        data: { role: 'read' },
      },
    ])
  })

  it('rejects invalid counts, duplicate thread names, and missing artifacts', () => {
    const snapshot = createSnapshot()

    expect(() =>
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        requireThreads: true,
        defaultThreads: [],
        plans: [{ name: 'bad', artifact: 'entry', count: 0 }],
      }),
    ).toThrow('count must be a positive integer')
    expect(() =>
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        requireThreads: true,
        defaultThreads: [],
        plans: [
          { name: 'dupe', artifact: 'entry' },
          { name: 'dupe', artifact: 'entry' },
        ],
      }),
    ).toThrow('duplicate thread name [dupe]')
    expect(() =>
      resolveThreadTopology({
        snapshot,
        runtimeName: 'api',
        requireThreads: true,
        defaultThreads: [],
        plans: [{ name: 'missing', artifact: 'missing' }],
      }),
    ).toThrow('thread artifact [missing] is missing')
  })
})

function createSnapshot(
  options: {
    artifacts?: NeemResolvedArtifact[]
    configRuntimes?: RuntimeSnapshot['config']['runtimes']
  } = {},
): RuntimeSnapshot {
  const artifacts = options.artifacts ?? [
    artifact('entry', 'api', '/out/api-entry.js'),
    artifact('entry', 'jobs', '/out/jobs-entry.js'),
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
      config: {
        runtimes: options.configRuntimes ?? {
          api: { threads: 1 },
          jobs: { threads: 1 },
        },
      },
      runtimes: {
        api: {
          name: 'api',
          entry: artifact('entry', 'api', '/out/api-entry.js'),
          artifacts: [],
        },
        jobs: {
          name: 'jobs',
          entry: artifact('entry', 'jobs', '/out/jobs-entry.js'),
          artifacts: [],
        },
      },
    },
    config: {
      runtimes: options.configRuntimes ?? {
        api: { threads: 1 },
        jobs: { threads: 1 },
      },
    },
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
    kind: 'worker',
    owner: { type: 'runtime', name: runtimeName },
    file,
    outDir: file.replace(/\/[^/]+$/, ''),
  }
}
