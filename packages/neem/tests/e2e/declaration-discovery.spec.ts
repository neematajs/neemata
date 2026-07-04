import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  runNeem,
  spawnNeem,
  waitFor,
} from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem runtime declaration discovery', () => {
  it('discovers runtime folders by glob, applies negation, and infers package names', async () => {
    const fixture = await useFixture({ config: 'discovery' })

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    const manifest = JSON.parse(
      await readFile(resolve(fixture.outDir, 'neem.manifest.json'), 'utf8'),
    ) as {
      runtimes: Record<string, unknown>
      config: { runtimes: Record<string, unknown> }
    }

    expect(Object.keys(manifest.runtimes)).toEqual(['@fixture/api'])
    expect(Object.keys(manifest.config.runtimes)).toEqual(['@fixture/api'])
    expect(JSON.stringify(manifest)).not.toContain('legacy')

    const neem = spawnTrackedNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const events = await waitFor(
      async () => {
        const current = await readRuntimeEvents(fixture.eventsFile)
        return current.some(
          (event) =>
            event.event === 'start' &&
            typeof event.name === 'string' &&
            event.name.startsWith('@fixture/api'),
        )
          ? current
          : false
      },
      30_000,
      () => `events:\n${JSON.stringify(neem.events(), null, 2)}`,
    )

    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'start',
          name: expect.stringContaining('legacy'),
        }),
      ]),
    )

    await neem.stop()
  }, 60_000)

  it('builds and starts worker, host, and planner entries from bare package specifiers', async () => {
    const fixture = await useFixture({ config: 'bare-package-entry' })

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    const manifest = await readManifest(fixture.outDir)
    expect(Object.keys(manifest.runtimes)).toEqual(['bare-package-entry'])

    const neem = spawnTrackedNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const events = await waitForRuntimeEvents(fixture.eventsFile, (current) =>
      current.some((event) => event.event === 'bare-package-worker-start') &&
      current.some((event) => event.event === 'bare-package-host-start')
        ? current
        : false,
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'bare-package-planner',
          name: 'bare-package-entry',
        }),
        expect.objectContaining({
          event: 'bare-package-worker-start',
          name: 'bare-package-entry:0',
        }),
        expect.objectContaining({
          event: 'bare-package-host-start',
          name: 'bare-package-entry',
          options: { fixture: 'bare-package-entry' },
          threads: ['bare-package-entry:0'],
        }),
      ]),
    )

    await neem.stop()
  }, 60_000)

  it('discovers conventional .cts runtime declarations and .cjs planners from runtime folders', async () => {
    const fixture = await useFixture({ config: 'cjs-cts-convention' })

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    const manifest = await readManifest(fixture.outDir)
    expect(Object.keys(manifest.runtimes)).toEqual(['cjs-cts-convention'])

    const neem = spawnTrackedNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const events = await waitForRuntimeEvents(fixture.eventsFile, (current) =>
      current.some(
        (event) =>
          event.event === 'start' && event.name === 'cjs-cts-convention:0',
      )
        ? current
        : false,
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'start',
          name: 'cjs-cts-convention:0',
        }),
      ]),
    )

    await neem.stop()
  }, 60_000)

  it('builds and starts runtime entries declared as file URLs', async () => {
    const fixture = await useFixture({ config: 'file-url-entry' })

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    const manifest = await readManifest(fixture.outDir)
    expect(Object.keys(manifest.runtimes)).toEqual(['file-url-entry'])

    const neem = spawnTrackedNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const events = await waitForRuntimeEvents(fixture.eventsFile, (current) =>
      current.some((event) => event.event === 'file-url-worker-start') &&
      current.some((event) => event.event === 'file-url-host-start')
        ? current
        : false,
    )

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'file-url-planner',
          name: 'file-url-entry',
        }),
        expect.objectContaining({
          event: 'file-url-worker-start',
          name: 'file-url-entry:0',
        }),
        expect.objectContaining({
          event: 'file-url-host-start',
          name: 'file-url-entry',
          options: { fixture: 'file-url-entry' },
          threads: ['file-url-entry:0'],
        }),
      ]),
    )

    await neem.stop()
  }, 60_000)

  it('fails build with a clear diagnostic for non-file URL entries', async () => {
    const fixture = await useFixture({ config: 'non-file-url-entry' })
    const neem = spawnTrackedNeem(
      ['build', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {},
    )

    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toContain(
      'Unsupported Neem artifact URL [https://example.test/neem-worker.js]: only file: URLs are supported',
    )
  }, 60_000)
})

type NeemManifest = {
  runtimes: Record<string, unknown>
  config: { runtimes: Record<string, unknown> }
}

async function useFixture(options: { config?: string } = {}) {
  const fixture = await createNeemFixture(options)
  fixtures.push(fixture)
  return fixture
}

async function readManifest(outDir: string): Promise<NeemManifest> {
  return JSON.parse(
    await readFile(resolve(outDir, 'neem.manifest.json'), 'utf8'),
  ) as NeemManifest
}

async function waitForRuntimeEvents(
  file: string,
  predicate: (
    events: Awaited<ReturnType<typeof readRuntimeEvents>>,
  ) => Awaited<ReturnType<typeof readRuntimeEvents>> | false,
): Promise<Awaited<ReturnType<typeof readRuntimeEvents>>> {
  return await waitFor(
    async () => predicate(await readRuntimeEvents(file)),
    30_000,
  )
}

function spawnTrackedNeem(
  args: readonly string[],
  options: Parameters<typeof spawnNeem>[1],
): SpawnedNeem {
  const neem = spawnNeem(args, options)
  spawned.push(neem)
  return neem
}
