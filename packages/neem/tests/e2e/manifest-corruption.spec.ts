import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import { createNeemFixture, runNeem, spawnNeem } from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

type CorruptibleManifest = Record<string, unknown> & {
  config?: Record<string, unknown> & {
    logger?: { type?: unknown; file?: unknown }
  }
  plugins?: Array<Record<string, unknown> & { entry?: { file?: unknown } }>
  runtime?: { worker?: { file?: unknown } }
  runtimes?: Record<
    string,
    { host?: { file?: unknown }; planner?: { file?: unknown } }
  >
}

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem production manifest corruption diagnostics', () => {
  it('fails production start with a parse diagnostic when manifest JSON is invalid', async () => {
    const fixture = await buildFixture()
    await writeFile(
      resolve(fixture.outDir, 'neem.manifest.json'),
      '{ invalid json',
    )

    const result = await startExpectingFailure(fixture.outDir)

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toMatch(
      /JSON|SyntaxError|Expected property|manifest/i,
    )
  }, 60_000)

  it('fails production start when the manifest config snapshot is missing', async () => {
    const fixture = await buildFixture()
    await updateManifest(fixture.outDir, (manifest) => {
      delete manifest.config
    })

    const result = await startExpectingFailure(fixture.outDir)

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toMatch(/config[\s\S]*Invalid input/i)
  }, 60_000)

  it('fails production start when the runtime worker entry file is missing', async () => {
    const fixture = await buildFixture()
    const manifest = await readManifest(fixture.outDir)
    const workerFile = manifest.runtime?.worker?.file
    expect(typeof workerFile).toBe('string')
    if (typeof workerFile !== 'string') {
      throw new Error('Expected manifest runtime worker file')
    }
    await rm(resolve(fixture.outDir, workerFile))

    const result = await startExpectingFailure(fixture.outDir)

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toMatch(
      /Missing Neem manifest file \[runtime\.worker\.file\]/i,
    )
    expect(result.output).toContain(workerFile)
  }, 60_000)

  it('fails production start when a plugin manifest entry is malformed', async () => {
    const fixture = await buildFixture({ config: 'plugin' })
    await updateManifest(fixture.outDir, (manifest) => {
      manifest.plugins = [{}]
    })

    const result = await startExpectingFailure(fixture.outDir)

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toMatch(
      /plugins[\s\S]*0[\s\S]*name[\s\S]*Invalid input/i,
    )
  }, 60_000)

  it('fails production start when a logger module file is missing', async () => {
    const fixture = await buildFixture({ config: 'plugin' })
    const manifest = await readManifest(fixture.outDir)
    const logger = manifest.config?.logger as
      | { type?: unknown; file?: unknown }
      | undefined
    expect(logger?.type).toBe('module')
    expect(typeof logger?.file).toBe('string')
    if (typeof logger?.file !== 'string') {
      throw new Error('Expected manifest logger file')
    }
    await rm(resolve(fixture.outDir, logger.file))

    const result = await startExpectingFailure(fixture.outDir)

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toMatch(
      /Missing Neem manifest file \[config\.logger\.file\]/i,
    )
    expect(result.output).toContain(logger.file)
  }, 60_000)

  it('fails production start when a plugin entry file is missing', async () => {
    const fixture = await buildFixture({ config: 'plugin' })
    const manifest = await readManifest(fixture.outDir)
    const pluginEntryFile = manifest.plugins?.[0]?.entry?.file
    expect(typeof pluginEntryFile).toBe('string')
    if (typeof pluginEntryFile !== 'string') {
      throw new Error('Expected manifest plugin entry file')
    }
    await rm(resolve(fixture.outDir, pluginEntryFile))

    const result = await startExpectingFailure(fixture.outDir)

    expect(result.exit.code).not.toBe(0)
    expect(result.output).toMatch(
      /Missing Neem manifest file \[plugins\.0\.entry\.file\]/i,
    )
    expect(result.output).toContain(pluginEntryFile)
  }, 60_000)

  it.each([
    ['host', /runtimes[\s\S]*api[\s\S]*host[\s\S]*file[\s\S]*Invalid input/i],
    [
      'planner',
      /runtimes[\s\S]*api[\s\S]*planner[\s\S]*file[\s\S]*Invalid input/i,
    ],
  ] as const)(
    'fails production start when the %s artifact file field is missing',
    async (artifact, diagnostic) => {
      const fixture = await buildFixture()
      await updateManifest(fixture.outDir, (manifest) => {
        const runtime = manifest.runtimes?.api
        if (!runtime?.[artifact]) {
          throw new Error(`Expected manifest ${artifact} artifact`)
        }
        delete runtime[artifact].file
      })

      const result = await startExpectingFailure(fixture.outDir)

      expect(result.exit.code).not.toBe(0)
      expect(result.output).toMatch(diagnostic)
    },
    60_000,
  )
})

async function buildFixture(options: { config?: string } = {}) {
  const fixture = await createNeemFixture(options)
  fixtures.push(fixture)
  await runNeem([
    'build',
    '--config',
    fixture.configFile,
    '--outDir',
    fixture.outDir,
  ])
  return fixture
}

async function startExpectingFailure(outDir: string): Promise<{
  exit: { code: number | null; signal: string | null }
  output: string
}> {
  const neem = spawnNeem(['start', '--outDir', outDir])
  spawned.push(neem)
  const exit = await neem.waitForExit()
  return { exit, output: [neem.stdout(), neem.stderr()].join('\n') }
}

async function updateManifest(
  outDir: string,
  update: (manifest: CorruptibleManifest) => void,
): Promise<void> {
  const manifest = await readManifest(outDir)
  update(manifest)
  await writeFile(
    resolve(outDir, 'neem.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

async function readManifest(outDir: string): Promise<CorruptibleManifest> {
  return JSON.parse(
    await readFile(resolve(outDir, 'neem.manifest.json'), 'utf8'),
  ) as CorruptibleManifest
}
