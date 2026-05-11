import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  NeemBuildManifest,
  NeemBuildManifestArtifact,
} from '../../../packages/neem/src/internal/commands/build.ts'
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
    // await Promise.all(
    //   tempDirs
    //     .splice(0)
    //     .map((dir) => rm(dir, { recursive: true, force: true })),
    // )
  })

  it('builds transformed config, app entry, plugin entry, plugin artifacts, and manifest', async () => {
    const outDir = await createTempOutDir()
    const staleNeemFile = resolve(outDir, 'apps/stale/old.js')
    const unrelatedFile = resolve(outDir, 'unrelated.txt')
    await mkdir(resolve(outDir, 'apps/stale'), { recursive: true })
    await writeFile(staleNeemFile, 'stale')
    await writeFile(unrelatedFile, 'keep')

    const result = await buildNeem({ config: configFile, outDir })
    const manifest = await readManifest(outDir)

    expect(result.manifestFile).toBe(resolve(outDir, NEEM_MANIFEST_FILE))
    expect(manifest.schemaVersion).toBe(1)
    expect(isAbsolute(manifest.config.file)).toBe(false)
    expect(manifest.config.file.endsWith('.js')).toBe(true)
    await expectFile(resolve(outDir, manifest.config.file))
    await expectMissing(staleNeemFile)
    await expectFile(unrelatedFile)

    const configFiles = await readdir(resolve(outDir, 'config/entry'))
    expect(
      configFiles.some((file) => /^neem\.config-[^.]+\.js$/.test(file)),
    ).toBe(true)
    expect(
      configFiles.some((file) => /^neem\.config-[^.]+\.js\.map$/.test(file)),
    ).toBe(true)
    expect(configFiles.some((file) => /^logger-[^.]+\.js$/.test(file))).toBe(
      true,
    )
    const configCode = await readFile(
      resolve(outDir, manifest.config.file),
      'utf8',
    )
    expect(configCode).toContain('import("./basic-app.ts")')
    expect(configCode).toContain('import("./basic-app.build.ts")')
    expect(configCode).toContain('import("./jobs.plugin.ts")')
    expect(configCode).not.toContain('import("./logger.ts")')

    const appEntry = manifest.apps.api.entry
    const plugin = manifest.plugins[0]
    expect(appEntry.id).toBe('entry')
    expect(appEntry.kind).toBe('module')
    expect(plugin?.entry.id).toBe('entry')
    expect(plugin?.entry.kind).toBe('module')

    const artifacts = [
      manifest.apps.api.entry,
      plugin?.entry,
      ...(plugin?.artifacts ?? []),
    ].filter(Boolean) as NeemBuildManifestArtifact[]

    for (const artifact of artifacts) {
      expect(isAbsolute(artifact.file)).toBe(false)
      expect(isAbsolute(artifact.outDir)).toBe(false)
      expect(artifact.file.endsWith('.js')).toBe(true)
      await expectFile(resolve(outDir, artifact.file))
    }

    const worker = plugin?.artifacts.find(
      (artifact) => artifact.id === 'job-worker',
    )
    const renderer = plugin?.artifacts.find(
      (artifact) => artifact.id === 'job-renderer',
    )

    expect(worker?.kind).toBe('worker')
    expect(renderer?.kind).toBe('module')
    expect(await readFile(resolve(outDir, worker!.file), 'utf8')).toContain(
      'jobs-worker',
    )
    expect(await readFile(resolve(outDir, renderer!.file), 'utf8')).toContain(
      'job:',
    )
  })

  it('runs build through the CLI', async () => {
    const outDir = await createTempOutDir()

    await expect(
      main(['build', '--config', configFile, '--outDir', outDir]),
    ).resolves.toBe(0)
    await expectFile(resolve(outDir, NEEM_MANIFEST_FILE))
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
