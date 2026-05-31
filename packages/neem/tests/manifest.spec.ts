import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  CompiledGraph,
  CompiledTarget,
} from '../src/internal/build/compiler.ts'
import type {
  Manifest,
  ManifestArtifact,
} from '../src/internal/manifest/manifest.ts'
import {
  assertManifestPath,
  createManifest as createCompiledManifest,
  MANIFEST_SCHEMA_VERSION,
  selectManifestRuntimes,
  toManifestPath,
  validateManifest,
  writeStartEntries,
} from '../src/internal/manifest/manifest.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true })),
  )
})

describe('Neem manifest', () => {
  it('validates relative manifest paths', () => {
    expect(() => assertManifestPath('runtime/start.js', 'entry')).not.toThrow()
    expect(() => assertManifestPath('', 'entry')).toThrow(
      'paths must be relative to output directory',
    )
    expect(() => assertManifestPath('/tmp/start.js', 'entry')).toThrow(
      'paths must be relative to output directory',
    )
    expect(() => assertManifestPath('../start.js', 'entry')).toThrow(
      'paths must be relative to output directory',
    )
  })

  it('selects manifest runtimes and matching config entries', () => {
    const manifest = createManifest()

    const selected = selectManifestRuntimes(manifest, [' jobs '])

    expect(Object.keys(selected.runtimes)).toEqual(['jobs'])
    expect(Object.keys(selected.config.runtimes)).toEqual(['jobs'])
    expect(() => selectManifestRuntimes(manifest, ['missing'])).toThrow(
      'Unknown Neem runtime(s): missing',
    )
  })

  it('creates runtime artifacts without requiring a worker artifact', () => {
    const manifest = createCompiledManifest(createCompiledHostOnlyGraph())

    expect(manifest.runtimes.scheduler).toMatchObject({
      name: 'scheduler',
      entry: undefined,
      host: { id: 'host', file: 'runtime/scheduler/host/index.js' },
      artifacts: [
        {
          id: 'scheduler-config',
          kind: 'module',
          file: 'runtime/scheduler/artifacts/000-scheduler-config/index.js',
        },
      ],
    })
  })

  it('writes root and per-runtime production start entries', async () => {
    const outDir = await useTempDir()

    await writeStartEntries(outDir, ['api', 'jobs'])

    await expect(readFile(resolve(outDir, 'start.js'), 'utf8')).resolves.toBe(
      [
        'import { startStandalone } from "./runtime/start.js"',
        'await startStandalone()',
        '',
      ].join('\n'),
    )
    await expect(
      readFile(resolve(outDir, 'runtimes/api/start.js'), 'utf8'),
    ).resolves.toBe(
      [
        'import { startStandalone } from "../../runtime/start.js"',
        'await startStandalone({ runtimes: ["api"] })',
        '',
      ].join('\n'),
    )
    await expect(
      readFile(resolve(outDir, 'runtimes/jobs/start.js'), 'utf8'),
    ).resolves.toContain('runtimes: ["jobs"]')
  })

  it('converts filesystem paths to slash-separated manifest paths', () => {
    expect(
      toManifestPath('/workspace/app/dist', '/workspace/app/dist/a/b.js'),
    ).toBe('a/b.js')
  })

  it('rejects invalid runtime artifact ownership and ids', () => {
    const wrongOwner = createManifest({
      runtimes: {
        api: {
          name: 'api',
          entry: artifact('entry', 'jobs', 'runtime/api/worker.js'),
          artifacts: [],
        },
      },
    })
    expect(() => validateManifest(wrongOwner)).toThrow(
      'entry owner must be runtime [api]',
    )

    const wrongId = createManifest({
      runtimes: {
        api: {
          name: 'api',
          entry: artifact('custom', 'api', 'runtime/api/worker.js'),
          artifacts: [],
        },
      },
    })
    expect(() => validateManifest(wrongId)).toThrow(
      'entry artifact id must be [entry]',
    )
  })
})

async function useTempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'neem-manifest-'))
  tempDirs.push(dir)
  return dir
}

function createManifest(overrides: Partial<Manifest> = {}): Manifest {
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    runtime: {
      entry: 'runtime/start.js',
      start: artifact('start', 'start', 'runtime/start.js', 'module'),
      worker: artifact(
        'worker-entry',
        'worker',
        'runtime/worker-entry.js',
        'worker',
      ),
    },
    config: { runtimes: { api: { threads: 1 }, jobs: { threads: 2 } } },
    runtimes: {
      api: {
        name: 'api',
        entry: artifact('entry', 'api', 'runtime/api/worker.js'),
        artifacts: [],
      },
      jobs: {
        name: 'jobs',
        entry: artifact('entry', 'jobs', 'runtime/jobs/worker.js'),
        artifacts: [],
      },
    },
  }

  return { ...manifest, ...overrides }
}

function artifact(
  id: string,
  runtimeName: string,
  file: string,
  kind: ManifestArtifact['kind'] = 'worker',
): ManifestArtifact {
  return {
    id,
    kind,
    owner: { type: 'runtime', name: runtimeName },
    file,
    outDir: file.replace(/\/[^/]+$/, ''),
  }
}

function createCompiledHostOnlyGraph(): CompiledGraph {
  const outDir = '/workspace/app/dist'
  const start = resolvedArtifact(
    'start',
    'start',
    `${outDir}/runtime/start.js`,
    'module',
  )
  const worker = resolvedArtifact(
    'worker-entry',
    'worker',
    `${outDir}/runtime/worker-entry.js`,
  )
  const host = resolvedArtifact(
    'host',
    'scheduler',
    `${outDir}/runtime/scheduler/host/index.js`,
    'module',
  )
  const config = resolvedArtifact(
    'scheduler-config',
    'scheduler',
    `${outDir}/runtime/scheduler/artifacts/000-scheduler-config/index.js`,
    'module',
  )

  return {
    graph: {
      outDir,
      config: {
        runtimes: {
          scheduler: {
            host: { entry: './scheduler.host.ts' },
            threads: 0,
            artifacts: [
              {
                id: 'scheduler-config',
                kind: 'module',
                entry: './scheduler.config.ts',
              },
            ],
          },
        },
      },
    },
    targets: [
      compiledTarget('start-entry', start),
      compiledTarget('worker-entry', worker),
    ],
    runtimes: [
      {
        name: 'scheduler',
        node: undefined,
        host: compiledTarget('runtime-host', host),
        artifacts: [compiledTarget('runtime-artifact', config)],
      },
    ],
    plugins: [],
  } as unknown as CompiledGraph
}

function compiledTarget(
  kind: CompiledTarget['target']['kind'],
  artifact: CompiledTarget['artifact'],
): CompiledTarget {
  return {
    target: {
      key: `${artifact.owner.type}:${artifact.id}`,
      kind,
      artifact: { id: artifact.id, kind: artifact.kind, entry: artifact.file },
      owner: artifact.owner,
      outDir: artifact.outDir,
    },
    artifact,
  }
}

function resolvedArtifact(
  id: string,
  runtimeName: string,
  file: string,
  kind: ManifestArtifact['kind'] = 'worker',
): CompiledTarget['artifact'] {
  return {
    id,
    kind,
    owner: { type: 'runtime', name: runtimeName },
    file,
    outDir: file.replace(/\/[^/]+$/, ''),
  }
}
