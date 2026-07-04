import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type {
  NeemProbeEvent,
  RuntimeEvent,
  SpawnedNeem,
} from './support/e2e.ts'
import {
  createNeemFixture,
  getFreePort,
  readRuntimeEvents,
  spawnNeem,
  updateFileAtomically,
  waitFor,
  writeFileAtomically,
} from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem watcher dev reload', () => {
  it('reports broken config, stops runtime, then restarts after the config is fixed', async () => {
    const fixture = await useFixture({ config: 'proxy' })
    const proxyPort = await getFreePort()
    const upstreamPort = await getFreePort()
    const originalConfig = await readFile(fixture.configFile, 'utf8')
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_PROXY_PORT: String(proxyPort),
          NEEM_PROXY_UPSTREAM_PORT: String(upstreamPort),
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await waitForProxy(proxyPort, neem)
    await waitForRuntimeEventCount(fixture.eventsFile, 'http-runtime-start', 1)

    await writeFileAtomically(
      fixture.configFile,
      "import { defineConfig } from '@nmtjs/neem'\n\nexport default defineConfig({\n",
    )

    const error = await neem.waitForEvent(
      (event) =>
        event.event === 'watcher:error' && isSerializedError(event.error),
      30_000,
    )
    expect(error.error).toMatchObject({ message: expect.any(String) })
    expect(
      neem.events().some((event) => event.event === 'runtime:stopped'),
    ).toBe(true)

    await writeFileAtomically(
      fixture.configFile,
      `${originalConfig}\nexport const fixedReloadMarker = true\n`,
    )

    await waitForProbeEventCount(neem, 'watcher:config-invalidated', 1)
    await waitForProbeEventCount(neem, 'runtime:ready', 2)
    await waitForRuntimeEventCount(fixture.eventsFile, 'http-runtime-stop', 1)
    await waitForRuntimeEventCount(fixture.eventsFile, 'http-runtime-start', 2)
    await waitForProxy(proxyPort, neem)

    await neem.stop()
  }, 60_000)

  it('removes stale runtime artifacts when a runtime is removed from config', async () => {
    const fixture = await useFixture({ config: 'generic-runtime' })
    const originalConfig = await readFile(fixture.configFile, 'utf8')
    const jobsStartFile = resolve(fixture.outDir, 'runtimes/jobs/start.js')
    const manifestFile = resolve(fixture.outDir, 'neem.manifest.json')
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await waitForProbeEventCount(neem, 'runtime:ready', 1)
    await waitForFile(jobsStartFile)
    await expectManifestRuntimes(manifestFile, ['api', 'jobs'])

    await writeFileAtomically(
      fixture.configFile,
      originalConfig.replace(", './jobs.runtime.ts'", ''),
    )

    await waitForProbeEventCount(neem, 'watcher:config-invalidated', 1)
    await waitForProbeEventCount(neem, 'runtime:ready', 2)
    await waitForMissingFile(jobsStartFile)
    await expectManifestRuntimes(manifestFile, ['api'])

    await neem.stop()
  }, 60_000)

  it('restarts watcher and runtime after a runtime declaration changes', async () => {
    const fixture = await useFixture({ config: 'generic-runtime' })
    const runtimeFile = resolve(
      fixture.fixtureDir,
      'cases/generic-runtime/api.runtime.ts',
    )
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await waitForProbeEventCount(neem, 'runtime:ready', 1)

    await replaceInFile(
      runtimeFile,
      "  name: 'api',",
      "  name: 'api',\n  env: { NEEM_ENV_RUNTIME_ONLY: 'runtime-declaration-v2' },",
    )

    await waitForProbeEventCount(neem, 'watcher:config-invalidated', 1)
    await waitForProbeEventCount(neem, 'runtime:ready', 2)
    await waitForRuntimeEvent(
      fixture.eventsFile,
      (event) =>
        event.event === 'runtime-create' &&
        event.name?.startsWith('api:') === true &&
        (event.env as Record<string, unknown> | undefined)?.runtimeOnly ===
          'runtime-declaration-v2',
    )

    await neem.stop()
  }, 60_000)

  it('converges rapid worker, logger, and plugin edits to the latest manifest', async () => {
    const fixture = await useFixture({ config: 'plugin' })
    const manifestFile = resolve(fixture.outDir, 'neem.manifest.json')
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

    const ready = await neem.waitForEvent(
      (event) => event.event === 'watcher:ready',
      30_000,
    )
    expectManifestEventIdentity(ready)
    await waitForRuntimeEventCount(fixture.eventsFile, 'runtime-start', 1)
    await waitForRuntimeEventCount(
      fixture.eventsFile,
      'plugin-runtime-ready',
      1,
    )

    await Promise.all([
      replaceInFile(
        workerFile,
        "record({ event: 'runtime-start', name: ctx.name })",
        "record({ event: 'runtime-start', name: ctx.name, marker: 'worker-v2' })",
      ),
      replaceInFile(loggerFile, "'Fixture',", "'Fixture logger-v2',"),
      replaceInFile(
        pluginFile,
        "event: 'plugin-runtime-ready',\n        name: event.name,",
        "event: 'plugin-runtime-ready',\n        marker: 'plugin-v2',\n        name: event.name,",
      ),
    ])

    const changeEvents = await waitForWatcherEventTypes(neem, [
      'watcher:runtime-changed',
      'watcher:logger-changed',
      'watcher:plugin-changed',
    ])
    const manifestEvents = [ready, ...changeEvents]
    for (const event of manifestEvents) expectManifestEventIdentity(event)
    expectStrictlyIncreasingManifestRevisions(manifestEvents)

    await waitForRuntimeEvent(
      fixture.eventsFile,
      (event) =>
        event.event === 'runtime-start' && event.marker === 'worker-v2',
    )
    await waitForRuntimeEvent(
      fixture.eventsFile,
      (event) =>
        event.event === 'plugin-runtime-ready' && event.marker === 'plugin-v2',
    )
    await expectManifestArtifactsContainMarkers(manifestFile, {
      worker: 'worker-v2',
      logger: 'logger-v2',
      plugin: 'plugin-v2',
    })

    await neem.stop()
  }, 60_000)
})

async function useFixture(options: { config?: string } = {}) {
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

async function waitForProbeEventCount(
  neem: SpawnedNeem,
  eventName: string,
  count: number,
): Promise<void> {
  await waitFor(
    () =>
      neem.events().filter((event) => event.event === eventName).length >=
      count,
    30_000,
    () => formatSpawnedOutput(neem),
  )
}

async function waitForRuntimeEventCount(
  file: string,
  eventName: string,
  count: number,
): Promise<void> {
  let lastEvents: RuntimeEvent[] = []
  await waitFor(
    async () => {
      const events = await readRuntimeEvents(file)
      lastEvents = events
      return events.filter((event) => event.event === eventName).length >= count
    },
    30_000,
    () => JSON.stringify(lastEvents, null, 2),
  )
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
    30_000,
    () => JSON.stringify(lastEvents, null, 2),
  )
}

async function waitForWatcherEventTypes(
  neem: SpawnedNeem,
  eventNames: readonly string[],
): Promise<NeemProbeEvent[]> {
  const required = new Set(eventNames)
  let lastEvents: readonly NeemProbeEvent[] = []
  return await waitFor(
    () => {
      const events = neem.events().filter((event) => required.has(event.event))
      lastEvents = events
      const seen = new Set(events.map((event) => event.event))
      return [...required].every((event) => seen.has(event)) ? events : false
    },
    30_000,
    () =>
      [JSON.stringify(lastEvents, null, 2), formatSpawnedOutput(neem)].join(
        '\n',
      ),
  )
}

async function waitForProxy(
  port: number,
  neem: SpawnedNeem,
): Promise<Record<string, any>> {
  return await waitFor(
    async () => {
      const response = await fetchJson(
        `http://127.0.0.1:${port}/api/proxy-check`,
      )
      return response?.status === 200 && response.body.runtime === 'api'
        ? response.body
        : false
    },
    30_000,
    () => formatSpawnedOutput(neem),
  )
}

async function expectManifestRuntimes(
  manifestFile: string,
  runtimes: string[],
): Promise<void> {
  await waitFor(async () => {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      runtimes?: Record<string, unknown>
    }
    expect(Object.keys(manifest.runtimes ?? {}).sort()).toEqual(runtimes)
    return true
  })
}

async function expectManifestArtifactsContainMarkers(
  manifestFile: string,
  markers: { worker: string; logger: string; plugin: string },
): Promise<void> {
  await waitFor(async () => {
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      config?: { logger?: { file?: string } }
      plugins?: Array<{ entry?: { file?: string } }>
      runtimes?: Record<string, { worker?: { file?: string } }>
    }

    const files = {
      worker: manifest.runtimes?.api?.worker?.file,
      logger: manifest.config?.logger?.file,
      plugin: manifest.plugins?.[0]?.entry?.file,
    }

    for (const [kind, file] of Object.entries(files)) {
      expect(file).toEqual(expect.any(String))
      const content = await readFile(
        resolve(resolve(manifestFile, '..'), file as string),
        'utf8',
      )
      expect(content).toContain(markers[kind as keyof typeof markers])
    }

    return true
  })
}

async function waitForFile(path: string): Promise<void> {
  await waitFor(async () => {
    await access(path)
    return true
  })
}

async function waitForMissingFile(path: string): Promise<void> {
  await waitFor(async () => {
    try {
      await access(path)
      return false
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  })
}

async function replaceInFile(
  path: string,
  search: string,
  replacement: string,
): Promise<void> {
  await updateFileAtomically(path, (content) => {
    expect(content).toContain(search)
    return content.replace(search, replacement)
  })
}

async function fetchJson(
  url: string,
): Promise<{ status: number; body: Record<string, any> } | undefined> {
  const response = await fetch(url).catch(() => undefined)
  if (!response) return undefined
  const text = await response.text()
  const body = parseJsonObject(text)
  return { status: response.status, body }
}

function expectManifestEventIdentity(event: NeemProbeEvent): void {
  expect(event).toMatchObject({
    manifestFile: expect.stringMatching(/neem\.manifest\.json$/),
    manifestRevision: expect.any(Number),
    manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
}

function expectStrictlyIncreasingManifestRevisions(
  events: readonly NeemProbeEvent[],
): void {
  const revisions = events.map((event) => event.manifestRevision)
  expect(revisions).toEqual(
    revisions
      .filter((revision): revision is number => typeof revision === 'number')
      .sort((left, right) => left - right),
  )
  expect(new Set(revisions).size).toBe(revisions.length)
}

function isSerializedError(
  value: unknown,
): value is { message: string; name?: string; stack?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}

function parseJsonObject(text: string): Record<string, any> {
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null
      ? (value as Record<string, any>)
      : {}
  } catch {
    return {}
  }
}

function formatSpawnedOutput(neem: SpawnedNeem): string {
  return [`stdout:\n${neem.stdout()}`, `stderr:\n${neem.stderr()}`].join('\n')
}
