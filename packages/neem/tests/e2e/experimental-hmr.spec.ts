import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeEvent, SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  spawnNeem,
  updateFileAtomically,
  waitFor,
} from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Rolldown DevEngine experiment', () => {
  it('applies a nested worker update in-process and falls back on rejection', async () => {
    const fixture = await createNeemFixture({ config: 'experimental-hmr' })
    fixtures.push(fixture)
    const valueFile = resolve(
      fixture.fixtureDir,
      'cases/experimental-hmr/hmr-value.ts',
    )
    const neem = spawnNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )
    spawned.push(neem)

    await waitForEventCount(fixture.eventsFile, 'experimental-hmr-start', 2)
    await replaceInFile(valueFile, "marker: 'v1'", "marker: 'v2'")

    await waitForEventCount(fixture.eventsFile, 'experimental-hmr-applied', 2)
    const applied = await readRuntimeEvents(fixture.eventsFile)
    expect(
      applied.filter(
        (event) =>
          event.event === 'experimental-hmr-applied' && event.marker === 'v2',
      ),
    ).toHaveLength(2)
    expect(
      applied.filter((event) => event.event === 'experimental-hmr-stop'),
    ).toHaveLength(0)

    await replaceInFile(valueFile, 'reject: false', 'reject: true')
    await neem.waitForEvent(
      (event) => event.event === 'runtime:hmr-fallback',
      30_000,
    )
    await waitForEventCount(fixture.eventsFile, 'experimental-hmr-stop', 2)
    await waitForEventCount(fixture.eventsFile, 'experimental-hmr-start', 4)

    await neem.stop()
  }, 60_000)

  it('refreshes full output when an update has no active clients', async () => {
    const fixture = await createNeemFixture({ config: 'experimental-hmr' })
    fixtures.push(fixture)
    const fixtureCase = resolve(fixture.fixtureDir, 'cases/experimental-hmr')
    const plannerFile = resolve(fixtureCase, 'api.planner.ts')
    const valueFile = resolve(fixtureCase, 'hmr-value.ts')
    await replaceInFile(
      plannerFile,
      "workers: [{ label: 'one' }, { label: 'two' }]",
      'workers: []',
    )

    const neem = spawnNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )
    spawned.push(neem)
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    await replaceInFile(valueFile, "marker: 'v1'", "marker: 'v2'")
    await neem.waitForEvent(
      (event) =>
        event.event === 'runtime:hmr-fallback' &&
        event.reason === 'No active HMR clients',
      30_000,
    )

    await replaceInFile(
      plannerFile,
      'workers: []',
      "workers: [{ label: 'one' }]",
    )
    await waitForEventCount(fixture.eventsFile, 'experimental-hmr-start', 1)
    const events = await readRuntimeEvents(fixture.eventsFile)
    expect(
      events.find((event) => event.event === 'experimental-hmr-start'),
    ).toMatchObject({ marker: 'v2' })

    await neem.stop()
  }, 60_000)
})

async function replaceInFile(
  file: string,
  search: string,
  replacement: string,
): Promise<void> {
  await updateFileAtomically(file, (content) => {
    expect(content).toContain(search)
    return content.replace(search, replacement)
  })
}

async function waitForEventCount(
  file: string,
  event: string,
  count: number,
): Promise<void> {
  let events: RuntimeEvent[] = []
  await waitFor(
    async () => {
      events = await readRuntimeEvents(file)
      return events.filter((item) => item.event === event).length >= count
    },
    30_000,
    () => JSON.stringify(events, null, 2),
  )
}
