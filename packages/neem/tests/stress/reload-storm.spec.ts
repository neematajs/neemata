import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeEvent, SpawnedNeem } from '../e2e/support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  spawnNeem,
  updateFileAtomically,
  waitFor,
} from '../e2e/support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem reload storm stress', () => {
  it('converges rapid worker, logger, and plugin edits to the final state', async () => {
    const fixture = await useFixture({ config: 'plugin' })
    const workerFile = resolve(
      fixture.fixtureDir,
      'shared/workers/generic-runtime.ts',
    )
    const loggerFile = resolve(fixture.fixtureDir, 'shared/support/logger.ts')
    const pluginFile = resolve(
      fixture.fixtureDir,
      'shared/support/plugin-hooks.ts',
    )
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForRuntimeEventCount(fixture.eventsFile, 'runtime-start', 1)

    for (let index = 1; index <= 3; index++) {
      await Promise.all([
        updateFileAtomically(workerFile, (content) =>
          setRuntimeStartMarker(content, `worker-stress-${index}`),
        ),
        updateFileAtomically(loggerFile, (content) =>
          content.replace(
            /'Fixture(?: logger-stress-\d+)?',/,
            `'Fixture logger-stress-${index}',`,
          ),
        ),
        updateFileAtomically(pluginFile, (content) =>
          setPluginReadyMarker(content, `plugin-stress-${index}`),
        ),
      ])
    }

    await waitForRuntimeEvent(
      fixture.eventsFile,
      (event) =>
        event.event === 'runtime-start' && event.marker === 'worker-stress-3',
    )
    await waitForRuntimeEvent(
      fixture.eventsFile,
      (event) =>
        event.event === 'plugin-runtime-ready' &&
        event.marker === 'plugin-stress-3',
    )

    const manifestFile = resolve(fixture.outDir, 'neem.manifest.json')
    await expectManifestArtifactMarkers(manifestFile, [
      'worker-stress-3',
      'logger-stress-3',
      'plugin-stress-3',
    ])

    await neem.stop()
  }, 120_000)
})

async function useFixture(options: { config: string }) {
  const fixture = await createNeemFixture(options)
  fixtures.push(fixture)
  return fixture
}

function spawnTrackedNeem(
  args: readonly string[],
  options: Parameters<typeof spawnNeem>[1],
): SpawnedNeem {
  const neem = spawnNeem(args, options)
  spawned.push(neem)
  return neem
}

function setRuntimeStartMarker(content: string, marker: string): string {
  const pattern =
    /record\(\{ event: 'runtime-start', name: ctx\.name(?:, marker: '[^']+')? \}\)/
  expect(content).toMatch(pattern)
  return content.replace(
    pattern,
    `record({ event: 'runtime-start', name: ctx.name, marker: '${marker}' })`,
  )
}

function setPluginReadyMarker(content: string, marker: string): string {
  if (content.includes("marker: 'plugin-stress-")) {
    return content.replace(/marker: 'plugin-stress-\d+'/, `marker: '${marker}'`)
  }
  const search = "event: 'plugin-runtime-ready',\n        name: event.name,"
  expect(content).toContain(search)
  return content.replace(
    search,
    `event: 'plugin-runtime-ready',\n        marker: '${marker}',\n        name: event.name,`,
  )
}

async function waitForRuntimeEventCount(
  file: string,
  eventName: string,
  count: number,
): Promise<void> {
  await waitFor(async () => {
    const events = await readRuntimeEvents(file)
    return events.filter((event) => event.event === eventName).length >= count
  }, 30_000)
}

async function waitForRuntimeEvent(
  file: string,
  predicate: (event: RuntimeEvent) => boolean,
): Promise<RuntimeEvent> {
  let lastEvents: RuntimeEvent[] = []
  return await waitFor(
    async () => {
      const events = await readRuntimeEvents(file)
      lastEvents = events
      return events.find(predicate)
    },
    45_000,
    () => JSON.stringify(lastEvents, null, 2),
  )
}

async function expectManifestArtifactMarkers(
  manifestFile: string,
  markers: readonly string[],
): Promise<void> {
  await waitFor(async () => {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      config?: { logger?: { file?: string } }
      plugins?: Array<{ entry?: { file?: string } }>
      runtimes?: Record<string, { worker?: { file?: string } }>
    }
    const files = [
      manifest.runtimes?.api?.worker?.file,
      manifest.config?.logger?.file,
      manifest.plugins?.[0]?.entry?.file,
    ]
    const content = await Promise.all(
      files.map(async (file) => {
        expect(file).toEqual(expect.any(String))
        return await readFile(
          resolve(resolve(manifestFile, '..'), file!),
          'utf8',
        )
      }),
    )
    for (const marker of markers) {
      expect(content.join('\n')).toContain(marker)
    }
    return true
  }, 30_000)
}
