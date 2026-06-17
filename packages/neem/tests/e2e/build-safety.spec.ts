import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import { createNeemFixture, spawnNeem } from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem build output safety', () => {
  it('preserves existing output when runtime declaration resolution fails', async () => {
    const fixture = await useFixture()
    await mkdir(fixture.outDir, { recursive: true })
    const previousStart = resolve(fixture.outDir, 'start.js')
    await writeFile(previousStart, 'previous deploy output\n')
    await writeFile(
      fixture.configFile,
      [
        "import { defineConfig } from '@nmtjs/neem'",
        '',
        'export default defineConfig({',
        "  runtimes: ['./missing/*.runtime.ts'],",
        '})',
        '',
      ].join('\n'),
    )

    const neem = spawnTrackedNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toContain('matched no files or folders')
    await expect(readFile(previousStart, 'utf8')).resolves.toBe(
      'previous deploy output\n',
    )
  }, 60_000)

  it('writes selected runtime names into both manifest runtime maps', async () => {
    const fixture = await useFixture({ config: 'selection' })

    const neem = spawnTrackedNeem([
      'build',
      'jobs',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    const exit = await neem.waitForExit()

    expect(exit.code).toBe(0)
    const manifest = JSON.parse(
      await readFile(resolve(fixture.outDir, 'neem.manifest.json'), 'utf8'),
    ) as {
      runtimes: Record<string, unknown>
      config: { runtimes: Record<string, unknown> }
    }
    expect(Object.keys(manifest.runtimes)).toEqual(['jobs'])
    expect(Object.keys(manifest.config.runtimes)).toEqual(['jobs'])
  }, 60_000)

  it('rejects writing build output into the config directory', async () => {
    const fixture = await useFixture()
    const cwd = resolve(fixture.fixtureDir, 'cases/runtime')
    const sentinel = resolve(cwd, 'sentinel.txt')
    await writeFile(sentinel, 'source tree data\n')

    const neem = spawnTrackedNeem(
      ['build', '--config', 'neem.config.ts', '--outDir', '.'],
      { cwd },
    )
    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toContain(
      'Neem output directory must not be the config directory',
    )
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('source tree data\n')
  }, 60_000)
})

async function useFixture(options: { config?: string } = {}) {
  const fixture = await createNeemFixture(options)
  fixtures.push(fixture)
  return fixture
}

function spawnTrackedNeem(
  args: readonly string[],
  options: Parameters<typeof spawnNeem>[1] = {},
): SpawnedNeem {
  const neem = spawnNeem(args, options)
  spawned.push(neem)
  return neem
}
