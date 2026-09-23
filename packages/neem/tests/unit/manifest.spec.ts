import { readdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type {
  CompiledGraph,
  CompiledTarget,
} from '../../src/internal/build/compiler.ts'
import type {
  Manifest,
  ManifestArtifact,
} from '../../src/internal/manifest/manifest.ts'
import {
  createManifest as createCompiledManifest,
  MANIFEST_SCHEMA_VERSION,
  readManifest,
  selectManifestRuntimes,
  toManifestPath,
  validateManifest,
  writeStartEntries,
} from '../../src/internal/manifest/manifest.ts'
import { createTempDir } from '../support/temp.ts'

describe('Neem manifest', () => {
  it('rejects manifest paths outside the output directory', () => {
    const manifest = createManifest({
      runtime: {
        entry: '../runtime/start.js',
        start: artifact('start', 'start', 'runtime/start.js', 'module'),
        worker: artifact(
          'worker-entry',
          'worker',
          'runtime/worker-entry.js',
          'worker',
        ),
        runner: artifact(
          'host-runner-entry',
          'host-runner',
          'runtime/runner-entry.js',
          'worker',
        ),
      },
    })

    expect(() => validateManifest(manifest)).toThrow(
      /runtime[\s\S]*entry[\s\S]*Invalid input/,
    )
  })

  it('validates proxy request limits', () => {
    const proxy = { hostname: '127.0.0.1', port: 8080 }
    const withLimits = (
      limits: unknown,
      maxRequestBodySize?: unknown,
    ): Manifest =>
      createManifest({
        config: {
          proxy: { ...proxy, limits },
          runtimes: { api: { proxy: { maxRequestBodySize } }, jobs: {} },
        },
      } as Partial<Manifest>)

    expect(() =>
      validateManifest(
        withLimits(
          { maxRequestBodySize: 8 * 1024 ** 3, maxUriSize: null },
          null,
        ),
      ),
    ).not.toThrow()
    expect(() => validateManifest(withLimits(null, 1024))).not.toThrow()
    expect(() =>
      validateManifest(withLimits({ maxRequestBodySize: 0 })),
    ).toThrow(/maxRequestBodySize/)
    expect(() => validateManifest(withLimits(undefined, 1.5))).toThrow(
      /maxRequestBodySize/,
    )
  })

  it('asks to rebuild a manifest written by another schema version', async () => {
    const outDir = await createTempDir('neem-manifest-')
    const manifestFile = resolve(outDir, 'neem.manifest.json')
    await writeFile(
      manifestFile,
      JSON.stringify({ ...createManifest(), schemaVersion: 1 }),
    )

    await expect(readManifest(manifestFile)).rejects.toThrow(
      /schema version \[1\], expected \[3\]; rebuild it with `neem build`/,
    )
  })

  it('accepts positive integer lifecycle timeouts only', () => {
    const withLifecycle = (lifecycle: unknown) =>
      createManifest({
        config: {
          runtimes: { api: {}, jobs: {} },
          lifecycle: lifecycle as Manifest['config']['lifecycle'],
        },
      })

    expect(() =>
      validateManifest(
        withLifecycle({ stopTimeout: 20_000, startTimeout: 60_000 }),
      ),
    ).not.toThrow()
    for (const invalid of [
      { stopTimeout: 0 },
      { startTimeout: 1.5 },
      { stopTimeout: 1_000, deadline: 5 },
    ]) {
      expect(() => validateManifest(withLifecycle(invalid))).toThrow(
        /lifecycle/,
      )
    }
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
    expect(manifest.config.lifecycle).toEqual({ stopTimeout: 20_000 })
    expect(manifest.config.runtimes.scheduler?.proxy).toEqual({
      routing: { type: 'path', name: 'scheduler' },
      sni: 'scheduler.localhost',
      maxRequestBodySize: null,
    })
    expect(manifest.runtime).toMatchObject({
      entry: 'start.js',
      start: { file: 'runtime/start.js' },
      worker: { file: 'runtime/worker-entry.js' },
      runner: { file: 'runtime/runner-entry.js' },
    })
    expect(manifest.runtimes.scheduler).toMatchObject({
      name: 'scheduler',
      env: { RUNTIME_ENV: 'scheduler' },
      worker: undefined,
      host: { id: 'host', file: 'runtime/scheduler/host/index.js' },
      planner: { id: 'planner', file: 'runtime/scheduler/planner/index.js' },
    })
  })

  it('writes root and per-runtime production start entries', async () => {
    const outDir = await createTempDir('neem-manifest-')

    await writeStartEntries(outDir, startLayout(['api', 'jobs']))

    await expect(readFile(resolve(outDir, 'start.js'), 'utf8')).resolves.toBe(
      rootStartEntry(),
    )
    await expect(
      readFile(resolve(outDir, 'runtimes/api/start.js'), 'utf8'),
    ).resolves.toBe(runtimeStartEntry('api'))
    await expect(
      readFile(resolve(outDir, 'runtimes/jobs/start.js'), 'utf8'),
    ).resolves.toContain('runtimes: ["jobs"]')
  })

  it('writes scoped runtime start entries in a single safe directory', async () => {
    const outDir = await createTempDir('neem-manifest-')

    await writeStartEntries(outDir, startLayout(['@scope/api']))

    const runtimeDirs = await readdir(resolve(outDir, 'runtimes'))
    expect(runtimeDirs).toHaveLength(1)
    await expect(
      readFile(
        resolve(outDir, 'runtimes', runtimeDirs[0]!, 'start.js'),
        'utf8',
      ),
    ).resolves.toBe(runtimeStartEntry('@scope/api'))
  })

  it('encodes traversal runtime names without escaping the output directory', async () => {
    const outDir = await createTempDir('neem-manifest-')

    await writeStartEntries(outDir, startLayout(['..']))

    await expect(readFile(resolve(outDir, 'start.js'), 'utf8')).resolves.toBe(
      rootStartEntry(),
    )
    const runtimeDirs = await readdir(resolve(outDir, 'runtimes'))
    expect(runtimeDirs).toHaveLength(1)
    expect(runtimeDirs[0]).not.toBe('..')
    await expect(
      readFile(
        resolve(outDir, 'runtimes', runtimeDirs[0]!, 'start.js'),
        'utf8',
      ),
    ).resolves.toBe(runtimeStartEntry('..'))
  })

  it('points start entries at the start module the manifest records', async () => {
    const outDir = await createTempDir('neem-manifest-')
    const layout = startLayout(['api'])
    layout.runtime.start = artifact(
      'start',
      'start',
      'runtime/standalone/start.js',
      'module',
    )

    await writeStartEntries(outDir, layout)

    await expect(readFile(resolve(outDir, 'start.js'), 'utf8')).resolves.toBe(
      rootStartEntry('./runtime/standalone/start.js'),
    )
    await expect(
      readFile(resolve(outDir, 'runtimes/api/start.js'), 'utf8'),
    ).resolves.toBe(
      runtimeStartEntry('api', '../../runtime/standalone/start.js'),
    )
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
      /runtimes[\s\S]*api[\s\S]*worker[\s\S]*owner/,
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
      /runtimes[\s\S]*api[\s\S]*worker[\s\S]*id/,
    )
  })

  it('rejects artifact kinds outside the manifest schema', () => {
    const manifest = createManifest({
      runtimes: {
        api: {
          name: 'api',
          worker: {
            ...artifact('worker', 'api', 'runtime/api/worker.js'),
            kind: 'asset' as ManifestArtifact['kind'],
          },
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

    expect(() => validateManifest(manifest)).toThrow(
      /runtimes[\s\S]*api[\s\S]*worker[\s\S]*kind/,
    )
  })
})

function rootStartEntry(specifier = './runtime/start.js'): string {
  return [
    `import { startStandalone } from ${JSON.stringify(specifier)}`,
    'await startStandalone()',
    '',
  ].join('\n')
}

function runtimeStartEntry(
  name: string,
  specifier = '../../runtime/start.js',
): string {
  return [
    `import { startStandalone } from ${JSON.stringify(specifier)}`,
    `await startStandalone({ runtimes: [${JSON.stringify(name)}] })`,
    '',
  ].join('\n')
}

function startLayout(
  names: readonly string[],
): Pick<Manifest, 'runtime' | 'runtimes'> {
  const { runtime, runtimes } = createManifest()
  return {
    runtime: { ...runtime, entry: 'start.js' },
    runtimes: Object.fromEntries(
      names.map((name) => [name, { ...runtimes.api!, name }]),
    ),
  }
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
      runner: artifact(
        'host-runner-entry',
        'host-runner',
        'runtime/runner-entry.js',
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
  const runner = resolvedArtifact(
    'host-runner-entry',
    'host-runner',
    `${outDir}/runtime/runner-entry.js`,
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
      config: {
        env: { ROOT_ENV: 'root' },
        lifecycle: { stopTimeout: 20_000 },
        runtimes: { scheduler: {} },
      },
    },
    targets: [
      compiledTarget('start-entry', start),
      compiledTarget('worker-entry', worker),
      compiledTarget('host-runner-entry', runner),
    ],
    runtimes: [
      {
        name: 'scheduler',
        node: {
          declaration: {
            declaration: {
              env: { RUNTIME_ENV: 'scheduler' },
              proxy: {
                routing: { type: 'path', name: 'scheduler' },
                sni: 'scheduler.localhost',
                maxRequestBodySize: null,
              },
            },
          },
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
