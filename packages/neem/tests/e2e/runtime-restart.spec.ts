import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  spawnNeem,
  updateFileAtomically,
  waitFor,
} from './support/e2e.ts'

describe('Neem runtime restart', () => {
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
          event.event === 'worker-generation-stop' &&
          event.threadId === next.threadId &&
          event.generation === 1,
      )
      expect(stopped).toBeGreaterThanOrEqual(0)
      expect(stopped).toBeLessThan(
        events.findIndex(
          (event) =>
            event.event === 'worker-generation-start' &&
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
      (event) => event.event === 'runtime:patch-fallback',
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
      'defineConfig({ build: { updates: { maxPatches: 2 } },',
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
      (event) => event.event === 'runtime:patch-fallback',
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
    const neem = start(fixture, { NEEM_RESTART_CRASH_FILE: crashFile })
    await generations(fixture, neem, 'v1', 1)
    await editMarker(fixture, 'v1', 'v2')
    await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)

    await writeFile(crashFile, '')
    await generations(fixture, neem, 'v2', 1)
    // Recovery-created threads must also be registered as patch clients.
    await editMarker(fixture, 'v2', 'v3')
    await generations(fixture, neem, 'v3', 2)
    await applied(neem, 2)
  }, 60_000)

  it('recovers a crashed runtime from output that includes accepted patches', async () => {
    const fixture = await createFixture()
    const crashFile = resolve(fixture.dir, 'crash')
    const retiredFile = resolve(fixture.dir, 'retired')
    const neem = start(fixture, {
      NEEM_RESTART_CRASH_FILE: crashFile,
      NEEM_RESTART_RETIRED_FILE: retiredFile,
    })
    await generations(fixture, neem, 'v1', 1)
    await editMarker(fixture, 'v1', 'v2')
    await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)

    // Pre-patch output would fail before readiness and exhaust recovery.
    await writeFile(retiredFile, '')
    await writeFile(crashFile, '')
    await generations(fixture, neem, 'v2', 1)
  }, 60_000)

  it('loads an edit to a lazily imported module that has not run yet', async () => {
    const fixture = await createFixture()
    const lazyFile = resolve(fixture.dir, 'lazy')
    const neem = start(fixture, { NEEM_RESTART_LAZY_FILE: lazyFile })
    await generations(fixture, neem, 'v1', 1)
    await replaceInFile(
      resolve(fixture.caseDir, 'lazy-value.ts'),
      "lazyValue = 'l1'",
      "lazyValue = 'l2'",
    )
    // Its chunk on disk predates the edit, so the runtime restarts from
    // refreshed output instead of accepting a patch it cannot apply.
    const fallback = await neem.waitForEvent(
      (event) => event.event === 'runtime:patch-fallback',
      30_000,
    )
    expect(fallback.reason).toContain('not run yet')
    await generations(fixture, neem, 'v1', 1, 4)

    await writeFile(lazyFile, '')
    const loaded = await waitFor(async () => {
      const events = (await readRuntimeEvents(fixture.eventsFile)).filter(
        (event) => event.event === 'lazy-loaded',
      )
      return events.length >= 2 ? events : undefined
    }, 30_000)
    expect(loaded.map((event) => event.value)).toEqual(['l2', 'l2'])
  }, 60_000)

  it('applies a runtime change that waited behind a worker output refresh', async () => {
    const fixture = await createFixture()
    await replaceInFile(
      fixture.configFile,
      "runtimes: ['./api.runtime.ts']",
      "runtimes: ['./api.runtime.ts', './aux.runtime.ts']",
    )
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)
    await auxStarted(fixture, 'one')

    // The replacement starts slowly and then falls back on its upstreams, so
    // the aux planner change queues behind the fallback's output refresh.
    await replaceInFile(
      fixture.valueFile,
      "marker: 'v1', upstream: false, startDelayMs: 0",
      "marker: 'v2', upstream: true, startDelayMs: 2000",
    )
    await generations(fixture, neem, 'v2', 2)
    await replaceInFile(
      resolve(fixture.caseDir, 'aux.planner.ts'),
      "label: 'one'",
      "label: 'two'",
    )
    await neem.waitForEvent(
      (event) =>
        event.event === 'watcher:runtime-changed' &&
        event.runtimeName === 'aux',
      30_000,
    )
    await auxStarted(fixture, 'two')
  }, 60_000)

  it('runs dispose callbacks of replaced modules with their hot data', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)
    await editMarker(fixture, 'v1', 'v2')
    await generations(fixture, neem, 'v2', 2)
    await editMarker(fixture, 'v2', 'v3')
    await generations(fixture, neem, 'v3', 3)

    const disposed = (await readRuntimeEvents(fixture.eventsFile))
      .filter((event) => event.event === 'definition-dispose')
      .map((event) => [event.marker, event.previous])
    expect(disposed).toHaveLength(4)
    expect(disposed).toEqual(
      expect.arrayContaining([
        ['v1', undefined],
        ['v2', 'v1'],
      ]),
    )
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
        event.event === 'runtime:patch-fallback' &&
        event.reason === 'No active patch clients',
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
      (event) => event.event === 'watcher:worker-patch-failed',
      30_000,
    )
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(0)

    await replaceInFile(fixture.valueFile, 'marker: !!!', "marker: 'v2'")
    await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)
  }, 60_000)

  it('defers a restart while the worker source fails to build', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)
    await editMarker(fixture, 'v1', 'v2')
    await generations(fixture, neem, 'v2', 2)
    await applied(neem, 1)

    await replaceInFile(fixture.valueFile, "marker: 'v2'", 'marker: !!!')
    await neem.waitForEvent(
      (event) => event.event === 'watcher:worker-patch-failed',
      30_000,
    )
    await replaceInFile(fixture.plannerFile, "label: 'one'", "label: 'changed'")
    await neem.waitForEvent(
      (event) =>
        event.event === 'runtime:restart-deferred' &&
        event.runtimeName === 'api',
      30_000,
    )
    expect(
      neem.events().filter((event) => event.event === 'runtime:thread-stopped'),
    ).toHaveLength(0)

    await replaceInFile(fixture.valueFile, 'marker: !!!', "marker: 'v3'")
    await generations(fixture, neem, 'v3', 1)
    const v1Starts = (await readRuntimeEvents(fixture.eventsFile)).filter(
      (event) =>
        event.event === 'worker-generation-start' && event.marker === 'v1',
    )
    expect(v1Starts).toHaveLength(2)
  }, 60_000)

  it('honors thread reload on the next worker definition', async () => {
    const fixture = await createFixture()
    const neem = start(fixture)
    await generations(fixture, neem, 'v1', 1)
    await replaceInFile(
      resolve(fixture.caseDir, 'api.worker.ts'),
      '  definition,',
      "  definition,\n  reload: 'thread',",
    )
    const fallback = await neem.waitForEvent(
      (event) => event.event === 'runtime:patch-fallback',
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
  const fixture = await createNeemFixture({ config: 'runtime-restart' })
  const caseDir = resolve(fixture.fixtureDir, 'cases/runtime-restart')
  const valueFile = resolve(caseDir, 'definition.ts')
  const plannerFile = resolve(caseDir, 'api.planner.ts')
  return { ...fixture, caseDir, valueFile, plannerFile }
}

function start(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnNeem(
    ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
    {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile, ...env },
    },
  )
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
          event.event === 'worker-generation-start' &&
          event.marker === marker &&
          event.generation === generation,
      )
      return events.length >= count ? events : undefined
    },
    30_000,
    () => JSON.stringify(neem.events()) + '\n' + neem.stderr(),
  )
}

async function auxStarted(fixture: { eventsFile: string }, label: string) {
  await waitFor(
    async () =>
      (await readRuntimeEvents(fixture.eventsFile)).some(
        (event) => event.event === 'aux-start' && event.label === label,
      ),
    30_000,
  )
}

async function applied(neem: SpawnedNeem, count: number) {
  await waitFor(
    () =>
      neem.events().filter((event) => event.event === 'runtime:patch-applied')
        .length >= count,
    30_000,
    () => JSON.stringify(neem.events()) + '\n' + neem.stderr(),
  )
}
