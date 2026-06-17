import { readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  getDistinctFreePorts,
  readRuntimeEvents,
  spawnNeem,
  waitFor,
  writeFileAtomically,
} from './support/e2e.ts'

const fixtures: Array<{ cleanup: () => Promise<void> }> = []
const spawned: SpawnedNeem[] = []

afterEach(async () => {
  await Promise.all(spawned.splice(0).map((neem) => neem.stop()))
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()))
})

describe('Neem recovery health and proxy behavior', () => {
  it('refreshes proxy routing after a recovered worker binds a new upstream port', async () => {
    const fixture = await useFixture({ config: 'recovery-proxy' })
    const [proxyPort, firstPort, secondPort] = await getDistinctFreePorts(3)
    const markerFile = resolve(fixture.dir, 'recovery-proxy-marker')
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

    const initial = await waitForJson(
      `http://127.0.0.1:${proxyPort}/api/proxy-check`,
      (response) =>
        response.status === 200 &&
        response.body.attempt === 1 &&
        response.body.port === firstPort,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(initial.body).toMatchObject({
      attempt: 1,
      port: firstPort,
      runtime: 'api',
      thread: 'api:0',
    })

    const crash = await fetchJson(`http://127.0.0.1:${proxyPort}/api/crash`)
    expect(crash?.status).toBe(200)
    expect(crash?.body).toMatchObject({ crashing: true, attempt: 1 })

    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) => event.event === 'recovery-proxy-start' && event.attempt === 2,
      1,
    )

    const directRecovered = await waitForJson(
      `http://127.0.0.1:${secondPort}/direct-check`,
      (response) =>
        response.status === 200 &&
        response.body.attempt === 2 &&
        response.body.port === secondPort,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(directRecovered.body).toMatchObject({
      attempt: 2,
      port: secondPort,
      runtime: 'api',
      thread: 'api:0',
    })

    const proxiedRecovered = await waitForJson(
      `http://127.0.0.1:${proxyPort}/api/proxy-check`,
      (response) =>
        response.status === 200 &&
        response.body.attempt === 2 &&
        response.body.port === secondPort,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(proxiedRecovered.body).toMatchObject({
      attempt: 2,
      port: secondPort,
      runtime: 'api',
      thread: 'api:0',
    })

    await neem.stop()
  }, 60_000)

  it('reports /ready as unavailable during worker recovery and ready after recovery', async () => {
    const fixture = await useFixture({ config: 'recovery-health' })
    const [healthPort, firstPort, secondPort] = await getDistinctFreePorts(3)
    const markerFile = resolve(fixture.dir, 'recovery-health-marker')
    await rm(markerFile, { force: true })

    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_HEALTH_PORT: String(healthPort),
          NEEM_RECOVERY_HEALTH_FIRST_PORT: String(firstPort),
          NEEM_RECOVERY_HEALTH_SECOND_PORT: String(secondPort),
          NEEM_RECOVERY_HEALTH_MARKER: markerFile,
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    const initialReady = await waitForJson(
      `http://127.0.0.1:${healthPort}/ready`,
      (response) => response.status === 200 && response.body.ok === true,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(initialReady.body).toMatchObject({
      ok: true,
      health: { ready: true },
    })

    const crash = await fetchJson(`http://127.0.0.1:${firstPort}/crash`)
    expect(crash?.status).toBe(200)
    expect(crash?.body).toMatchObject({ crashing: true, attempt: 1 })

    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) => event.event === 'recovery-health-delay' && event.attempt === 2,
      1,
    )

    const recovering = await fetchJson(`http://127.0.0.1:${healthPort}/ready`)
    expect(recovering?.status).toBe(503)
    expect(recovering?.body).toMatchObject({
      ok: false,
      health: { ready: false, state: 'running' },
    })
    expect(recovering?.body.health.runtimes[0].pool).toMatchObject({
      state: 'starting',
      starting: 1,
    })

    const recoveredReady = await waitForJson(
      `http://127.0.0.1:${healthPort}/ready`,
      (response) => response.status === 200 && response.body.ok === true,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(recoveredReady.body).toMatchObject({
      ok: true,
      health: { ready: true },
    })

    const recoveredUpstream = await waitForJson(
      `http://127.0.0.1:${secondPort}/health-check`,
      (response) =>
        response.status === 200 &&
        response.body.attempt === 2 &&
        response.body.port === secondPort,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(recoveredUpstream.body).toMatchObject({
      attempt: 2,
      port: secondPort,
      runtime: 'api',
      thread: 'api:0',
    })

    await neem.stop()
  }, 60_000)

  it('keeps health and proxy safe when a worker reload fails during start and recovers after a fix', async () => {
    const fixture = await useFixture({ config: 'reload-start-failure' })
    const [proxyPort, healthPort, upstreamPort] = await getDistinctFreePorts(3)
    const workerFile = resolve(
      fixture.fixtureDir,
      'cases/reload-start-failure/reload-start-failure.worker.ts',
    )
    const originalWorker = await readFile(workerFile, 'utf8')
    const badWorker = originalWorker
      .replace(
        "const RESPONSE_VERSION = 'good-v1'",
        "const RESPONSE_VERSION = 'bad-partial'",
      )
      .replace('const FAIL_ON_START = false', 'const FAIL_ON_START = true')
    const fixedWorker = originalWorker.replace(
      "const RESPONSE_VERSION = 'good-v1'",
      "const RESPONSE_VERSION = 'good-v2'",
    )
    expect(badWorker).not.toBe(originalWorker)
    expect(fixedWorker).not.toBe(originalWorker)

    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_RELOAD_START_FAILURE_PROXY_PORT: String(proxyPort),
          NEEM_RELOAD_START_FAILURE_HEALTH_PORT: String(healthPort),
          NEEM_RELOAD_START_FAILURE_UPSTREAM_PORT: String(upstreamPort),
          NEEM_RELOAD_START_FAILURE_DELAY_MS: '2000',
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    const initial = await waitForJson(
      `http://127.0.0.1:${proxyPort}/api/proxy-check`,
      (response) =>
        response.status === 200 && response.body.version === 'good-v1',
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(initial.body).toMatchObject({
      runtime: 'api',
      thread: 'api:0',
      version: 'good-v1',
    })

    await writeFileAtomically(workerFile, badWorker)
    await neem.waitForEvent(
      (event) => event.event === 'watcher:runtime-changed',
      30_000,
    )
    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) =>
        event.event === 'reload-start-failure-listening' &&
        event.version === 'bad-partial',
      1,
    )

    const reloadingReady = await fetchJson(
      `http://127.0.0.1:${healthPort}/ready`,
    )
    expect(reloadingReady?.status).toBe(503)
    expect(reloadingReady?.body).toMatchObject({
      ok: false,
      health: { ready: false },
    })

    const reloadingProxy = await fetchJson(
      `http://127.0.0.1:${proxyPort}/api/proxy-check`,
    )
    expect(reloadingProxy?.body.version).not.toBe('bad-partial')

    const failedReady = await waitForJson(
      `http://127.0.0.1:${healthPort}/ready`,
      (response) =>
        response.status === 503 &&
        response.body.health?.ready === false &&
        response.body.health?.lastError?.message?.includes('bad-partial') ===
          true,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(failedReady.body.health).toMatchObject({
      state: 'failed',
      ready: false,
      lastError: { message: expect.stringContaining('bad-partial') },
    })

    await writeFileAtomically(workerFile, fixedWorker)
    await waitForProbeEventCount(neem, 'watcher:runtime-changed', 2)
    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) =>
        event.event === 'reload-start-failure-listening' &&
        event.version === 'good-v2',
      1,
    )

    const recoveredReady = await waitForJson(
      `http://127.0.0.1:${healthPort}/ready`,
      (response) => response.status === 200 && response.body.ok === true,
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(recoveredReady.body).toMatchObject({
      ok: true,
      health: { ready: true },
    })
    expect(recoveredReady.body.health.lastError).toBeUndefined()

    const recoveredProxy = await waitForJson(
      `http://127.0.0.1:${proxyPort}/api/proxy-check`,
      (response) =>
        response.status === 200 && response.body.version === 'good-v2',
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(recoveredProxy.body).toMatchObject({
      runtime: 'api',
      thread: 'api:0',
      version: 'good-v2',
    })

    await neem.stop()
  }, 90_000)
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

async function waitForMatchingEventCount(
  file: string,
  predicate: (
    event: Awaited<ReturnType<typeof readRuntimeEvents>>[number],
  ) => boolean,
  count: number,
): Promise<void> {
  let lastEvents: Awaited<ReturnType<typeof readRuntimeEvents>> = []
  await waitFor(
    async () => {
      const events = await readRuntimeEvents(file)
      lastEvents = events
      return events.filter(predicate).length >= count
    },
    30_000,
    () =>
      `Waiting for matching event x${count}\n${JSON.stringify(lastEvents, null, 2)}`,
  )
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

type JsonResponse = { status: number; body: Record<string, any> }

async function waitForJson(
  url: string,
  predicate: (response: JsonResponse) => boolean,
  timeoutMs: number,
  getDetails: () => string,
): Promise<JsonResponse> {
  let lastResponse: JsonResponse | undefined
  return await waitFor(
    async () => {
      const response = await fetchJson(url)
      if (response) lastResponse = response
      return response && predicate(response) ? response : false
    },
    timeoutMs,
    () =>
      [
        `url: ${url}`,
        `lastResponse: ${JSON.stringify(lastResponse)}`,
        getDetails(),
      ].join('\n'),
  )
}

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
