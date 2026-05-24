import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/commands/build.ts'
import { main } from '../../../packages/neem/src/cli.ts'
import {
  buildNeem,
  NEEM_MANIFEST_FILE,
} from '../../../packages/neem/src/internal/commands/build.ts'

const fixturesDir = resolve(import.meta.dirname, '../fixtures')
const configFile = resolve(fixturesDir, 'neem.config.ts')
const tempDirs: string[] = []

describe('neem build', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('builds transformed config, runtime entry, and manifest', async () => {
    const outDir = await createTempOutDir()
    const staleNeemFile = resolve(outDir, 'runtimes/stale/old.js')
    const unrelatedFile = resolve(outDir, 'unrelated.txt')
    await mkdir(resolve(outDir, 'runtimes/stale'), { recursive: true })
    await writeFile(staleNeemFile, 'stale')
    await writeFile(unrelatedFile, 'keep')

    const result = await buildNeem({ config: configFile, outDir })
    const manifest = await readManifest(outDir)

    expect(result.manifestFile).toBe(resolve(outDir, NEEM_MANIFEST_FILE))
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.runtime).toEqual({
      entry: 'start.js',
      worker: 'runtime/worker-entry.js',
    })
    expect(isAbsolute(manifest.runtime!.entry)).toBe(false)
    expect(isAbsolute(manifest.runtime!.worker)).toBe(false)
    await expectFile(resolve(outDir, manifest.runtime!.entry))
    await expectFile(resolve(outDir, 'runtime/start.js'))
    await expectFile(resolve(outDir, manifest.runtime!.worker))
    expect(manifest.config.runtimes.api).toEqual({
      threads: [{ http: { listen: { hostname: '127.0.0.1', port: 3000 } } }],
    })
    expect(manifest.config.logger).toMatchObject({ type: 'module' })
    if (manifest.config.logger?.type !== 'module') {
      throw new Error('Expected module logger artifact')
    }
    await expectMissing(staleNeemFile)
    await expectFile(unrelatedFile)

    await expectMissing(resolve(outDir, 'config/entry'))
    await expectFile(resolve(outDir, manifest.config.logger.file))
    const startCode = await readFile(
      resolve(outDir, manifest.runtime!.entry),
      'utf8',
    )
    expect(startCode).toContain('from "./runtime/start.js"')
    expect(startCode).toContain('await startStandalone()')
    expect(startCode).not.toContain('@nmtjs/neem/cli')
    expect(startCode).not.toMatch(/(?:from|import)\(?["']@nmtjs\/neem/)
    const runtimeStartCode = await readFile(
      resolve(outDir, 'runtime/start.js'),
      'utf8',
    )
    expect(runtimeStartCode).not.toContain('NEEM_RUNTIMES')
    expect(runtimeStartCode).not.toContain('@nmtjs/neem/cli')
    expect(runtimeStartCode).not.toMatch(/(?:from|import)\(?["']@nmtjs\/neem/)

    const runtimeEntry = manifest.runtimes?.api?.entry
    expect(runtimeEntry?.id).toBe('entry')
    expect(runtimeEntry?.kind).toBe('worker')

    if (!runtimeEntry) throw new Error('Missing runtime entry')
    for (const artifact of [runtimeEntry]) {
      expect(isAbsolute(artifact.file)).toBe(false)
      expect(isAbsolute(artifact.outDir)).toBe(false)
      expect(artifact.file.endsWith('.js')).toBe(true)
      await expectFile(resolve(outDir, artifact.file))
    }
  })

  it('runs build through the CLI', async () => {
    const outDir = await createTempOutDir()

    await expect(
      main(['build', '--config', configFile, '--outDir', outDir]),
    ).resolves.toBe(0)
    await expectFile(resolve(outDir, NEEM_MANIFEST_FILE))
  })

  it('builds generic runtime entries and host artifacts', async () => {
    const outDir = await createTempOutDir()

    await buildNeem({
      config: resolve(fixturesDir, 'generic-runtime.config.ts'),
      outDir,
    })
    const manifest = await readManifest(outDir)

    expect(Object.keys(manifest.runtimes ?? {})).toEqual(['api', 'jobs'])
    expect(manifest.runtimes?.api?.entry).toMatchObject({
      id: 'entry',
      kind: 'worker',
      owner: { type: 'runtime', name: 'api' },
    })
    expect(manifest.runtimes?.jobs?.host).toMatchObject({
      id: 'host',
      kind: 'module',
      owner: { type: 'runtime', name: 'jobs' },
    })

    await expectFile(resolve(outDir, manifest.runtimes!.api.entry.file))
    await expectFile(resolve(outDir, manifest.runtimes!.jobs.entry.file))
    await expectFile(resolve(outDir, manifest.runtimes!.jobs.host!.file))
  })

  it('builds helper-emitted worker artifacts', async () => {
    const outDir = await createTempOutDir()

    await buildNeem({
      config: resolve(fixturesDir, 'runtime-jobs.config.ts'),
      outDir,
    })
    const manifest = await readManifest(outDir)

    expect(manifest.runtimes?.jobs?.host).toMatchObject({
      id: 'host',
      kind: 'module',
      owner: { type: 'runtime', name: 'jobs' },
    })
    expect(manifest.runtimes?.jobs?.artifacts).toEqual([
      expect.objectContaining({
        id: 'job-runner',
        kind: 'worker',
        owner: { type: 'runtime', name: 'jobs' },
      }),
    ])
    await expectFile(resolve(outDir, manifest.runtimes!.jobs.entry.file))
    await expectFile(resolve(outDir, manifest.runtimes!.jobs.host!.file))
    await expectFile(
      resolve(outDir, manifest.runtimes!.jobs.artifacts[0]!.file),
    )
  })

  it('builds eventing runtime with emitted config artifact', async () => {
    const outDir = await createTempOutDir()

    await buildNeem({
      config: resolve(fixturesDir, 'runtime-eventing.config.ts'),
      outDir,
    })
    const manifest = await readManifest(outDir)

    expect(manifest.runtimes?.events?.entry).toMatchObject({
      id: 'entry',
      kind: 'worker',
      owner: { type: 'runtime', name: 'events' },
    })
    expect(manifest.runtimes?.events?.artifacts).toEqual([
      expect.objectContaining({
        id: 'eventing-config',
        kind: 'module',
        owner: { type: 'runtime', name: 'events' },
      }),
    ])
    await expectFile(resolve(outDir, manifest.runtimes!.events.entry.file))
    await expectFile(
      resolve(outDir, manifest.runtimes!.events.artifacts[0]!.file),
    )
  })

  it('builds only selected generic runtimes', async () => {
    const outDir = await createTempOutDir()

    await buildNeem({
      config: resolve(fixturesDir, 'generic-runtime.config.ts'),
      outDir,
      runtimes: ['api'],
    })
    const manifest = await readManifest(outDir)

    expect(Object.keys(manifest.runtimes ?? {})).toEqual(['api'])
    await expectFile(resolve(outDir, manifest.runtimes!.api.entry.file))
    await expectFile(resolve(outDir, 'runtimes/api/start.js'))
    const startCode = await readFile(resolve(outDir, 'runtimes/api/start.js'), {
      encoding: 'utf8',
    })
    expect(startCode).toContain('from "../../runtime/start.js"')
    expect(startCode).toContain(`await startStandalone({ runtimes: ["api"] })`)
    expect(startCode).not.toContain('NEEM_RUNTIMES')
    await expectMissing(resolve(outDir, 'runtimes/jobs/start.js'))
  })

  it('does not execute runtime entry thunks while building runtime artifacts', async () => {
    delete (globalThis as any).__neemLazyAppLoaded
    const outDir = await createTempOutDir()

    await buildNeem({ config: resolve(fixturesDir, 'lazy.config.ts'), outDir })

    expect((globalThis as any).__neemLazyAppLoaded).toBeUndefined()
  })
})

async function createTempOutDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'neem-build-'))
  tempDirs.push(dir)
  return dir
}

async function readManifest(outDir: string): Promise<NeemBuildManifest> {
  return JSON.parse(
    await readFile(resolve(outDir, NEEM_MANIFEST_FILE), 'utf8'),
  ) as NeemBuildManifest
}

async function expectFile(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined()
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow()
}
