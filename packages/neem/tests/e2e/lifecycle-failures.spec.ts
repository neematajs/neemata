import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  readRuntimeEvents,
  runNeem,
  spawnNeem,
  spawnNode,
  waitFor,
} from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem runtime lifecycle failures', () => {
  it('awaits async runtime worker factories before starting workers', async () => {
    const fixture = await useFixture({ config: 'async-worker-factory' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const events = await waitFor(
      async () => {
        const current = await readRuntimeEvents(fixture.eventsFile)
        return current.some((event) => event.event === 'async-start')
          ? current
          : false
      },
      30_000,
      () => `events:\n${JSON.stringify(neem.events(), null, 2)}`,
    )
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'async-create-start',
        'async-create-ready',
        'async-start',
      ]),
    )

    await neem.stop()
  }, 60_000)

  it('fails startup with a clear error when a worker returns an invalid upstream', async () => {
    const fixture = await useFixture({ config: 'bad-upstream' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toMatch(/\$ZodError[\s\S]*invalid_format[\s\S]*url/)
  }, 60_000)

  it('stops already-started workers when a later worker fails startup', async () => {
    const fixture = await useFixture({ config: 'start-failure-cleanup' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    const exit = await neem.waitForExit()
    const events = await readRuntimeEvents(fixture.eventsFile)

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toContain('partial startup failure api:1')
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'partial-start',
          label: 'started',
          name: 'api:0',
        }),
        expect.objectContaining({
          event: 'partial-start',
          label: 'failing',
          name: 'api:1',
        }),
        expect.objectContaining({
          event: 'partial-stop',
          label: 'started',
          name: 'api:0',
        }),
      ]),
    )
    expect(countEvents(events, 'partial-stop', 'api:0')).toBe(1)
    expect(indexOfEvent(events, 'partial-stop', 'api:0')).toBeGreaterThan(
      indexOfEvent(events, 'partial-start', 'api:0'),
    )
  }, 60_000)

  it('fails startup when runtime host start exceeds the request timeout', async () => {
    const fixture = await useFixture({ config: 'host-start-hang' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS: '200',
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toContain(
      'Neem host runner request [start] timed out after 200ms',
    )
  }, 60_000)

  it('fails startup when runtime planner exceeds the request timeout', async () => {
    const fixture = await useFixture({ config: 'planner-hang' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS: '200',
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toContain(
      'Neem host runner request [plan] timed out after 200ms',
    )
  }, 60_000)

  it('fails shutdown when runtime host stop exceeds the request timeout', async () => {
    const fixture = await useFixture({ config: 'host-stop-hang' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS: '200',
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    const startedAt = Date.now()
    const exit = await neem.stop({ killAfterMs: 2_000 })

    expect(exit).toMatchObject({ code: 0, signal: null })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    await waitFor(
      async () => {
        const events = await readRuntimeEvents(fixture.eventsFile)
        return events.some((event) => event.event === 'host-stop-hang-stop')
      },
      1_000,
      () => `events:\n${JSON.stringify(neem.events(), null, 2)}`,
    )
  }, 60_000)

  it('runs production SIGTERM shutdown exactly once', async () => {
    const fixture = await useFixture({ config: 'sigterm-exactly-once' })

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    const node = spawnTrackedNode([resolve(fixture.outDir, 'start.js')], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })

    await waitFor(
      async () => {
        const events = await readRuntimeEvents(fixture.eventsFile)
        if (
          countEvents(events, 'sigterm-runtime-start') === 1 &&
          countEvents(events, 'sigterm-host-start') === 1 &&
          countEvents(events, 'sigterm-plugin-initialize') === 1
        ) {
          return events
        }
        return false
      },
      30_000,
      () => formatSpawnedOutput(node),
    )

    const exit = await node.stop({ killAfterMs: 5_000 })
    const events = await readRuntimeEvents(fixture.eventsFile)

    expect(exit).toMatchObject({ code: 0, signal: null })
    expect(countEvents(events, 'sigterm-runtime-stop')).toBe(1)
    expect(countEvents(events, 'sigterm-host-stop')).toBe(1)
    expect(countEvents(events, 'sigterm-plugin-dispose')).toBe(1)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'sigterm-runtime-stop',
          mode: 'production',
        }),
        expect.objectContaining({
          event: 'sigterm-host-stop',
          mode: 'production',
        }),
        expect.objectContaining({
          event: 'sigterm-plugin-dispose',
          mode: 'production',
        }),
      ]),
    )
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

function spawnTrackedNode(
  args: readonly string[],
  options: Parameters<typeof spawnNode>[1],
): SpawnedNeem {
  const node = spawnNode(args, options)
  spawned.push(node)
  return node
}

function countEvents(
  events: readonly { event: string; name?: string }[],
  event: string,
  name?: string,
): number {
  return events.filter(
    (current) => current.event === event && (!name || current.name === name),
  ).length
}

function indexOfEvent(
  events: readonly { event: string; name?: string }[],
  event: string,
  name: string,
): number {
  return events.findIndex(
    (current) => current.event === event && current.name === name,
  )
}

function formatSpawnedOutput(neem: SpawnedNeem): string {
  return [`stdout:\n${neem.stdout()}`, `stderr:\n${neem.stderr()}`].join('\n')
}
