import { appendFile, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from '../support/e2e.ts'
import {
  createNeemFixture,
  expectFile,
  readRuntimeEvents,
  runNeem,
  spawnNeem,
  waitFor,
} from '../support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem v2 services', () => {
  it('writes manifest and standalone start entries', async () => {
    const fixture = await useFixture()

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    await expectFile(resolve(fixture.outDir, 'neem.manifest.json'))
    await expectFile(resolve(fixture.outDir, 'start.js'))
    await expectFile(resolve(fixture.outDir, 'runtime/start.js'))
    await expectFile(resolve(fixture.outDir, 'runtime/worker-entry.js'))
    await expectFile(resolve(fixture.outDir, 'runtimes/api/start.js'))

    const startEntry = await readFile(
      resolve(fixture.outDir, 'runtime/start.js'),
      'utf8',
    )
    expect(startEntry).not.toContain('oxc-resolver')
    expect(startEntry).not.toContain('internal/build/resolver')

    const manifest = JSON.parse(
      await readFile(resolve(fixture.outDir, 'neem.manifest.json'), 'utf8'),
    )
    expect(Object.keys(manifest.runtimes)).toEqual(['api'])
  })

  it('starts watcher/runtime services and shuts them down gracefully', async () => {
    const fixture = await useFixture({ config: 'generic-runtime.config.ts' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'watcher:ready', 30_000)
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    await neem.stop()
    expect(
      neem.events().some((event) => event.event === 'cli:dev:closed'),
    ).toBe(true)

    const events = await readRuntimeEvents(fixture.eventsFile)
    expect(events.some((event) => event.event === 'host-stop')).toBe(true)
    expect(events.some((event) => event.event === 'runtime-stop')).toBe(true)
  }, 60_000)

  it('emits lifecycle logs and manifest config trace', async () => {
    const fixture = await useFixture({ config: 'generic-runtime.config.ts' })
    const logsFile = resolve(fixture.dir, 'logs.jsonl')
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_LOG_EVENTS_FILE: logsFile,
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const logs = await waitFor(
      async () => {
        const events = await readLogEvents(logsFile)
        return events.some((event) => event.msg === 'Neem server ready') &&
          events.some((event) => event.msg === 'Neem manifest config loaded') &&
          events.some((event) => event.msg === 'Neem worker starting')
          ? events
          : false
      },
      30_000,
      () => `logs:\n${neem.stdout()}\n${neem.stderr()}`,
    )

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 30,
          msg: 'Neem server ready',
          $label: 'neem:server',
        }),
        expect.objectContaining({
          level: 10,
          msg: 'Neem manifest config loaded',
          $label: 'neem:server',
          config: expect.objectContaining({
            runtimes: expect.objectContaining({
              api: expect.objectContaining({
                threads: expect.arrayContaining([
                  expect.objectContaining({ label: 'one' }),
                ]),
              }),
            }),
          }),
        }),
        expect.objectContaining({
          level: 10,
          msg: 'Neem worker starting',
          $label: 'runtime:api:0',
        }),
      ]),
    )

    await neem.stop()
  }, 60_000)

  it('reloads a runtime when its host artifact changes', async () => {
    const fixture = await useFixture({ config: 'generic-runtime.config.ts' })
    const hostFile = resolve(fixture.fixtureDir, 'generic-runtime-host.ts')
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'host-setup', 1)

    await appendFile(hostFile, "\nexport const reloadMarker = 'changed'\n")

    await neem.waitForEvent(
      (event) => event.event === 'watcher:runtime-host-changed',
      30_000,
    )
    await waitForEventCount(fixture.eventsFile, 'host-setup', 2)
    await waitForEventCount(fixture.eventsFile, 'host-stop', 1)

    await neem.stop()
  }, 60_000)

  it('runs host-only zero-thread runtimes', async () => {
    const fixture = await useFixture({ config: 'host-only.config.ts' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'host-only-start', 1)

    const events = await readRuntimeEvents(fixture.eventsFile)
    const start = events.find((event) => event.event === 'host-only-start')
    expect(start).toMatchObject({ threads: 0, upstreams: 0 })

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

async function waitForEventCount(
  file: string,
  eventName: string,
  count: number,
): Promise<void> {
  let lastEvents: Awaited<ReturnType<typeof readRuntimeEvents>> = []
  await waitFor(
    async () => {
      const events = await readRuntimeEvents(file)
      lastEvents = events
      return events.filter((event) => event.event === eventName).length >= count
    },
    30_000,
    () =>
      `Waiting for ${eventName} x${count}\n${JSON.stringify(lastEvents, null, 2)}`,
  )
}

async function readLogEvents(
  file: string,
): Promise<Array<Record<string, any>>> {
  const content = await readFile(file, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
}
