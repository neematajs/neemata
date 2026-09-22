import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
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

describe('Neem worker HMR', () => {
  it('patches both threads in place after a leaf edit', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    const initial = await generations(fixture, neem, 'v1', 1)

    await editMarker(fixture, 'v1', 'v2')
    const updated = await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)

    expect(new Set(updated.map((event) => event.threadId))).toEqual(
      new Set(initial.map((event) => event.threadId)),
    )
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(0)
    const events = await readRuntimeEvents(fixture.eventsFile)
    for (const next of updated) {
      const stopped = events.findIndex(
        (event) =>
          event.event === 'worker-hmr-stop' &&
          event.threadId === next.threadId &&
          event.generation === 1,
      )
      expect(stopped).toBeGreaterThanOrEqual(0)
      expect(stopped).toBeLessThan(
        events.findIndex(
          (event) =>
            event.event === 'worker-hmr-start' &&
            event.threadId === next.threadId &&
            event.generation === 2,
        ),
      )
    }
  }, 60_000)

  it('restarts both threads from fresh output when upstreams change', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    const initial = await generations(fixture, neem, 'v1', 1)

    await replaceInFile(
      fixture.valueFile,
      "marker: 'v1', upstream: false",
      "marker: 'v2', upstream: true",
    )
    const fallback = await neem.waitForEvent(
      (event) => event.event === 'runtime:hmr-fallback',
      30_000,
    )
    expect(fallback.reason).toContain('upstreams')
    const restarted = await generations(fixture, neem, 'v2', 1)
    expect(
      restarted.every(
        (event) =>
          !initial.some((previous) => previous.threadId === event.threadId),
      ),
    ).toBe(true)
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(2)
  }, 60_000)

  it('starts the patched marker after a planner-only reload', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)
    await editMarker(fixture, 'v1', 'v2')
    await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)

    await replaceInFile(fixture.plannerFile, "label: 'one'", "label: 'changed'")
    await generations(fixture, neem, 'v2', 1)
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(2)
  }, 60_000)

  it('restarts on the third edit when the patch budget is two', async () => {
    const fixture = await createFixture()
    await replaceInFile(
      fixture.configFile,
      'defineConfig({',
      'defineConfig({ build: { hmr: { maxPatches: 2 } },',
    )
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)

    for (let patch = 1; patch <= 2; patch++) {
      await editMarker(fixture, `v${patch}`, `v${patch + 1}`)
      await generations(fixture, neem, `v${patch + 1}`, patch + 1)
      await applied(neem, patch)
    }
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(0)

    await editMarker(fixture, 'v3', 'v4')
    const fallback = await neem.waitForEvent(
      (event) => event.event === 'runtime:hmr-fallback',
      30_000,
    )
    expect(fallback.reason).toContain('patch budget')
    await generations(fixture, neem, 'v4', 1)
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(2)
  }, 60_000)

  it('refreshes a stale bundle after host-internal crash recovery', async () => {
    const fixture = await createFixture()
    const crashFile = resolve(fixture.dir, 'crash')
    const neem = start(fixture, { NEEM_HMR_CRASH_FILE: crashFile })
    await generations(fixture, neem, 'v1', 1)
    await editMarker(fixture, 'v1', 'v2')
    await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)

    await writeFile(crashFile, '')
    await generations(fixture, neem, 'v2', 1)
    // Recovery-created threads must also be registered as HMR clients.
    await editMarker(fixture, 'v2', 'v3')
    await generations(fixture, neem, 'v3', 2)
    await applied(neem, 2)
  }, 60_000)

  it('refreshes full output when an update has no active clients', async () => {
    const fixture = await createFixture()
    await replaceInFile(
      fixture.plannerFile,
      "workers: [{ label: 'one' }, { label: 'two' }]",
      'workers: []',
    )
    const neem = start(fixture)
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    await editMarker(fixture, 'v1', 'v2')
    await neem.waitForEvent(
      (event) =>
        event.event === 'runtime:hmr-fallback' &&
        event.reason === 'No active HMR clients',
      30_000,
    )
    await replaceInFile(
      fixture.plannerFile,
      'workers: []',
      "workers: [{ label: 'one' }]",
    )
    await generations(fixture, neem, 'v2', 1, 1)
  }, 60_000)

  it('keeps the last generation on a syntax error and patches after repair', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)
    await replaceInFile(fixture.valueFile, "marker: 'v1'", 'marker: !!!')
    await neem.waitForEvent(
      (event) => event.event === 'watcher:worker-hmr-failed',
      30_000,
    )
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(0)

    await replaceInFile(fixture.valueFile, 'marker: !!!', "marker: 'v2'")
    await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)
  }, 60_000)

  it('honors thread reload on the next worker definition', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)
    await replaceInFile(
      resolve(fixture.caseDir, 'api.worker.ts'),
      '  definition: hmrValue,',
      "  definition: hmrValue,\n  reload: 'thread',",
    )
    const fallback = await neem.waitForEvent(
      (event) => event.event === 'runtime:hmr-fallback',
      30_000,
    )
    expect(fallback.reason).toContain("reload: 'thread'")
    await waitFor(
      () =>
        neem
          .events()
          .filter((event) => event.event === 'runtime:thread-started')
          .length === 4,
      30_000,
    )
  }, 60_000)
})

async function createFixture() {
  const fixture = await createNeemFixture({ config: 'worker-hmr' })
  fixtures.push(fixture)
  const caseDir = resolve(fixture.fixtureDir, 'cases/worker-hmr')
  const valueFile = resolve(caseDir, 'hmr-value.ts')
  const plannerFile = resolve(caseDir, 'api.planner.ts')
  return { ...fixture, caseDir, valueFile, plannerFile }
}

function start(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  env: NodeJS.ProcessEnv = {},
) {
  const neem = spawnNeem(
    ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
    {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile, ...env },
    },
  )
  spawned.push(neem)
  return neem
}

function editMarker(
  fixture: { valueFile: string },
  previous: string,
  next: string,
) {
  return replaceInFile(
    fixture.valueFile,
    `marker: '${previous}'`,
    `marker: '${next}'`,
  )
}

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

async function generations(
  fixture: { eventsFile: string },
  neem: SpawnedNeem,
  marker: string,
  generation: number,
  count = 2,
) {
  return waitFor(
    async () => {
      const events = (await readRuntimeEvents(fixture.eventsFile)).filter(
        (event) =>
          event.event === 'worker-hmr-start' &&
          event.marker === marker &&
          event.generation === generation,
      )
      return events.length >= count ? events : undefined
    },
    30_000,
    () => JSON.stringify(neem.events()) + '\n' + neem.stderr(),
  )
}

async function applied(neem: SpawnedNeem, count: number) {
  await waitFor(
    () =>
      neem.events().filter((event) => event.event === 'runtime:hmr-applied')
        .length >= count,
    30_000,
    () => JSON.stringify(neem.events()) + '\n' + neem.stderr(),
  )
}
