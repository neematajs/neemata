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

  it('creates runtime host and planner artifacts without requiring worker', () => {
    const manifest = createCompiledManifest(createCompiledHostOnlyGraph())

    expect(manifest.config.env).toEqual({ ROOT_ENV: 'root' })
    expect(manifest.runtimes.scheduler).toMatchObject({
      name: 'scheduler',
      env: { RUNTIME_ENV: 'scheduler' },
      worker: undefined,
      host: { id: 'host', file: 'runtime/scheduler/host/index.js' },
      planner: { id: 'planner', file: 'runtime/scheduler/planner/index.js' },
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
          worker: artifact('worker', 'jobs', 'runtime/api/worker.js'),
          host: artifact('host', 'api', 'runtime/api/host.js', 'module'),
          planner: artifact(
            'planner',
            'api',
            'runtime/api/planner.js',
            'module',
          ),
        },
      },
    })
    expect(() => validateManifest(wrongOwner)).toThrow(
      'worker owner must be runtime [api]',
    )

    const wrongId = createManifest({
      runtimes: {
        api: {
          name: 'api',
          worker: artifact('custom', 'api', 'runtime/api/worker.js'),
          host: artifact('host', 'api', 'runtime/api/host.js', 'module'),
          planner: artifact(
            'planner',
            'api',
            'runtime/api/planner.js',
            'module',
          ),
        },
      },
    })
    expect(() => validateManifest(wrongId)).toThrow(
      'worker artifact id must be [worker]',
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
    config: { runtimes: { api: {}, jobs: {} } },
    runtimes: {
      api: {
        name: 'api',
        worker: artifact('worker', 'api', 'runtime/api/worker.js'),
        host: artifact('host', 'api', 'runtime/api/host.js', 'module'),
        planner: artifact('planner', 'api', 'runtime/api/planner.js', 'module'),
      },
      jobs: {
        name: 'jobs',
        worker: artifact('worker', 'jobs', 'runtime/jobs/worker.js'),
        host: artifact('host', 'jobs', 'runtime/jobs/host.js', 'module'),
        planner: artifact(
          'planner',
          'jobs',
          'runtime/jobs/planner.js',
          'module',
        ),
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
  const planner = resolvedArtifact(
    'planner',
    'scheduler',
    `${outDir}/runtime/scheduler/planner/index.js`,
    'module',
  )

  return {
    graph: {
      outDir,
      config: { env: { ROOT_ENV: 'root' }, runtimes: { scheduler: {} } },
    },
    targets: [
      compiledTarget('start-entry', start),
      compiledTarget('worker-entry', worker),
    ],
    runtimes: [
      {
        name: 'scheduler',
        node: {
          declaration: { declaration: { env: { RUNTIME_ENV: 'scheduler' } } },
        },
        host: compiledTarget('runtime-host', host),
        planner: compiledTarget('runtime-planner', planner),
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
