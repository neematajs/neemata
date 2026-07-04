import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { RuntimeEvent, SpawnedNeem } from '../e2e/support/e2e.ts'
import {
  createNeemFixture,
  getDistinctFreePorts,
  readRuntimeEvents,
  spawnNeem,
  waitFor,
} from '../e2e/support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem recovery stress', () => {
  it('recovers repeated worker crashes and returns health to ready', async () => {
    const fixture = await useFixture({ config: 'recovery-proxy' })
    const [proxyPort, firstPort, secondPort] = await getDistinctFreePorts(3)
    const markerFile = resolve(fixture.dir, 'recovery-stress-marker')
    await rm(markerFile, { force: true })

    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_PROXY_PORT: String(proxyPort),
          NEEM_RECOVERY_PROXY_FIRST_PORT: String(firstPort),
          NEEM_RECOVERY_PROXY_SECOND_PORT: String(secondPort),
          NEEM_RECOVERY_PROXY_MARKER: markerFile,
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await expectProxyAttempt(proxyPort, 1, neem)

    for (let index = 0; index < 2; index++) {
      const crash = await fetchJson(`http://127.0.0.1:${proxyPort}/api/crash`)
      expect(crash?.status).toBe(200)
      await expectProxyAttempt(proxyPort, 2, neem)
    }

    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) => event.event === 'recovery-proxy-start',
      3,
    )

    await neem.stop()
    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) => event.event === 'recovery-proxy-stop',
      1,
    )
  }, 120_000)

  it('bounds slow host stop with harness kill-after diagnostics', async () => {
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
    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) => event.event === 'host-stop-hang-stop',
      1,
    )
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

async function expectProxyAttempt(
  proxyPort: number,
  attempt: number,
  neem: SpawnedNeem,
): Promise<void> {
  await waitFor(
    async () => {
      const response = await fetchJson(
        `http://127.0.0.1:${proxyPort}/api/recovery-stress`,
      )
      return response?.status === 200 && response.body.attempt === attempt
    },
    45_000,
    () => formatSpawnedOutput(neem),
  )
}

async function waitForMatchingEventCount(
  file: string,
  predicate: (event: RuntimeEvent) => boolean,
  count: number,
): Promise<void> {
  let lastEvents: RuntimeEvent[] = []
  await waitFor(
    async () => {
      const events = await readRuntimeEvents(file)
      lastEvents = events
      return events.filter(predicate).length >= count
    },
    45_000,
    () => JSON.stringify(lastEvents, null, 2),
  )
}

type JsonResponse = { status: number; body: Record<string, any> }

async function fetchJson(url: string): Promise<JsonResponse | undefined> {
  const response = await fetch(url).catch(() => undefined)
  if (!response) return undefined
  const text = await response.text()
  return { status: response.status, body: parseJsonObject(text) }
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
