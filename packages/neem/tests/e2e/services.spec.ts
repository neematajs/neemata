import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { SpawnedNeem } from './support/e2e.ts'
import {
  createNeemFixture,
  expectFile,
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

  it('starts built output without importing source config', async () => {
    const fixture = await useFixture()

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    await writeFile(
      fixture.configFile,
      "throw new Error('source config must not be imported by start')\n",
    )

    const neem = spawnTrackedNeem(['start', '--outDir', fixture.outDir], {
      env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile },
    })
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'start', 2)

    await neem.stop()
  }, 60_000)

  it('runs generated production runtime wrappers', async () => {
    const fixture = await useFixture()

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    const node = spawnTrackedNode(
      [resolve(fixture.outDir, 'runtimes/api/start.js')],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )
    await waitForEventCount(fixture.eventsFile, 'start', 2)

    await node.stop()
  }, 60_000)

  it('starts watcher/runtime services and shuts them down gracefully', async () => {
    const fixture = await useFixture({ config: 'generic-runtime' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'watcher:ready', 30_000)
    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const exit = await neem.stop()
    expect(exit).toMatchObject({ code: 0, signal: null })

    const probeEvents = neem.events().map((event) => event.event)
    expect(probeEvents).toContain('runtime:stopped')
    expect(probeEvents).toContain('cli:dev:closed')
    expect(probeEvents.indexOf('runtime:stopped')).toBeLessThan(
      probeEvents.indexOf('cli:dev:closed'),
    )

    const events = await readRuntimeEvents(fixture.eventsFile)
    expect(events.some((event) => event.event === 'host-stop')).toBe(true)
    expect(events.some((event) => event.event === 'runtime-stop')).toBe(true)
  }, 60_000)

  it('passes merged env defaults to planner, host, and worker threads', async () => {
    const fixture = await useFixture({ config: 'generic-runtime' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_ENV_EXECUTION_OVERRIDE: 'execution',
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const events = await readRuntimeEvents(fixture.eventsFile)
    const hostSetup = events.find(
      (event) => event.event === 'host-setup' && event.name === 'jobs',
    )
    const runtimeCreate = events.find(
      (event) => event.event === 'runtime-create' && event.name === 'jobs:0',
    )
    const expectedEnv = {
      rootOnly: 'root',
      runtimeOnly: 'runtime',
      layered: 'runtime',
      executionOverride: 'execution',
    }

    expect(hostSetup).toMatchObject({
      env: expectedEnv,
      options: { env: expectedEnv },
    })
    expect(runtimeCreate).toMatchObject({ env: expectedEnv })

    await neem.stop()
  }, 60_000)

  it('imports dev config in the watcher worker, not the CLI main thread', async () => {
    const fixture = await useFixture({ config: 'config-import' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)

    const events = await readRuntimeEvents(fixture.eventsFile)
    const imports = events.filter((event) => event.event === 'config-import')
    expect(imports.length).toBeGreaterThan(0)
    expect(imports.every((event) => event.isMainThread === false)).toBe(true)

    await neem.stop()
  }, 60_000)

  it('restarts watcher and runtime after config invalidation', async () => {
    const fixture = await useFixture({ config: 'config-import' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await appendFile(fixture.configFile, '\nexport const reloadMarker = 1\n')

    await neem.waitForEvent(
      (event) => event.event === 'watcher:config-invalidated',
      30_000,
    )
    await waitForEventCount(fixture.eventsFile, 'config-import', 2)
    await waitForEventCount(fixture.eventsFile, 'runtime-start', 2)
    expect(
      neem.events().some((event) => event.event === 'runtime:stopped'),
    ).toBe(true)

    await neem.stop()
  }, 60_000)

  it('emits lifecycle logs and manifest config trace', async () => {
    const fixture = await useFixture({ config: 'generic-runtime' })
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
          events.some((event) => event.msg === 'Neem manifest config') &&
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
          msg: 'Neem manifest config',
          $label: 'neem:server',
          config: expect.objectContaining({
            runtimes: expect.objectContaining({ api: {} }),
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

  it('reports readiness as unavailable while runtimes are still starting', async () => {
    const fixture = await useFixture({ config: 'health-slow' })
    const port = await getFreePort()
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_HEALTH_PORT: String(port),
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    const notReady = await waitFor(
      async () => {
        const response = await fetchJson(`http://127.0.0.1:${port}/readyz`)
        return response?.status === 503 ? response.body : false
      },
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(notReady).toMatchObject({
      ok: false,
      health: { ready: false, state: 'starting' },
    })

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    const ready = await fetchJson(`http://127.0.0.1:${port}/readyz`)
    expect(ready?.status).toBe(200)
    expect(ready?.body).toMatchObject({ ok: true, health: { ready: true } })

    await neem.stop()
  }, 60_000)

  it('serves health and readiness probes from the runtime service', async () => {
    const fixture = await useFixture({ config: 'health' })
    const port = await getFreePort()
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_HEALTH_PORT: String(port),
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    const ready = await waitFor(
      async () => {
        const response = await fetchJson(`http://127.0.0.1:${port}/readyz`)
        return response?.status === 200 ? response.body : false
      },
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(ready).toMatchObject({
      ok: true,
      health: { ready: true, runtimeNames: ['api'] },
    })

    const health = await fetchJson(`http://127.0.0.1:${port}/healthz`)
    expect(health?.status).toBe(200)
    expect(health?.body).toMatchObject({
      ok: true,
      health: { state: 'running' },
    })

    await neem.stop()
  }, 60_000)

  it('serves metrics from the metrics plugin and restarts without leaking the port', async () => {
    const fixture = await useFixture({ config: 'metrics' })
    const port = await getFreePort()
    const logsFile = resolve(fixture.dir, 'metrics-logs.jsonl')
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_LOG_EVENTS_FILE: logsFile,
          NEEM_METRICS_PORT: String(port),
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'runtime-start', 1)

    const initialMetrics = await waitForMetrics(port, neem)
    expect(initialMetrics).toContain('neem_lifecycle_events_total')
    expect(initialMetrics).toContain('neem_runtime_ready')
    expect(initialMetrics).toContain('process_cpu_user_seconds_total')

    const startLog = await waitFor(
      async () => {
        const logs = await readLogEvents(logsFile)
        return (
          logs.find(
            (event) =>
              event.msg ===
              `Metrics server started at http://127.0.0.1:${port}/metrics`,
          ) ?? false
        )
      },
      30_000,
      () => formatSpawnedOutput(neem),
    )
    expect(startLog).toMatchObject({
      msg: `Metrics server started at http://127.0.0.1:${port}/metrics`,
    })

    await appendFile(
      fixture.configFile,
      "\nexport const metricsReloadMarker = 'changed'\n",
    )

    await neem.waitForEvent(
      (event) => event.event === 'watcher:config-invalidated',
      30_000,
    )
    await waitForEventCount(fixture.eventsFile, 'runtime-start', 2)

    const reloadedMetrics = await waitForMetrics(port, neem)
    expect(reloadedMetrics).toContain('neem_lifecycle_events_total')
    expect(reloadedMetrics).toContain('process_cpu_user_seconds_total')

    await neem.stop()
  }, 60_000)

  it('routes traffic through the native proxy to runtime upstreams', async () => {
    const fixture = await useFixture({ config: 'proxy' })
    const proxyPort = await getFreePort()
    const upstreamPort = await getFreePort()
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

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    const proxied = await waitFor(
      async () => {
        const response = await fetchJson(
          `http://127.0.0.1:${proxyPort}/api/proxy-check`,
        )
        return response?.status === 200 && response.body.runtime === 'api'
          ? response.body
          : false
      },
      30_000,
      () => formatSpawnedOutput(neem),
    )

    expect(proxied).toMatchObject({ runtime: 'api', thread: 'api:0' })

    await neem.stop()
  }, 60_000)

  it('reloads a runtime when its host artifact changes', async () => {
    const fixture = await useFixture({ config: 'generic-runtime' })
    const hostFile = resolve(
      fixture.fixtureDir,
      'cases/generic-runtime/jobs.host.ts',
    )
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

  it('reloads a runtime when its worker artifact changes', async () => {
    const fixture = await useFixture()
    const workerFile = resolve(
      fixture.fixtureDir,
      'shared/workers/runtime-app.ts',
    )
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'start', 2)

    await appendFile(
      workerFile,
      "\nexport const workerReloadMarker = 'changed'\n",
    )

    await neem.waitForEvent(
      (event) => event.event === 'watcher:runtime-changed',
      30_000,
    )
    await waitForEventCount(fixture.eventsFile, 'stop', 2)
    await waitForEventCount(fixture.eventsFile, 'start', 4)

    await neem.stop()
  }, 60_000)

  it('reloads all runtimes when the logger artifact changes', async () => {
    const fixture = await useFixture({ config: 'logger-reload' })
    const loggerFile = resolve(fixture.fixtureDir, 'shared/support/logger.ts')
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'runtime-start', 1)

    await appendFile(
      loggerFile,
      "\nexport const loggerReloadMarker = 'changed'\n",
    )

    await neem.waitForEvent(
      (event) => event.event === 'watcher:logger-changed',
      30_000,
    )
    await waitForEventCount(fixture.eventsFile, 'runtime-stop', 1)
    await waitForEventCount(fixture.eventsFile, 'runtime-start', 2)

    await neem.stop()
  }, 60_000)

  it('restarts runtime service when plugin artifacts change', async () => {
    const fixture = await useFixture({ config: 'plugin' })
    const pluginFile = resolve(
      fixture.fixtureDir,
      'shared/support/plugin-hooks.ts',
    )
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'plugin-setup', 1)
    await waitForEventCount(fixture.eventsFile, 'plugin-initialize', 1)

    await appendFile(
      pluginFile,
      "\nexport const pluginReloadMarker = 'changed'\n",
    )

    await neem.waitForEvent(
      (event) => event.event === 'watcher:plugin-changed',
      30_000,
    )
    await waitForEventCount(fixture.eventsFile, 'plugin-dispose', 1)
    await waitForEventCount(fixture.eventsFile, 'plugin-setup', 2)
    await waitForEventCount(fixture.eventsFile, 'plugin-initialize', 2)

    await neem.stop()
    await waitForEventCount(fixture.eventsFile, 'plugin-dispose', 2)
  }, 60_000)

  it('fails startup when a plugin hook throws and disposes plugin hooks once', async () => {
    const fixture = await useFixture({ config: 'throwing-plugin' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    const exit = await neem.waitForExit()
    expect(exit.code).not.toBe(0)
    await waitForEventCount(
      fixture.eventsFile,
      'throwing-plugin-server-start',
      1,
    )
    await waitForEventCount(fixture.eventsFile, 'throwing-plugin-dispose', 1)
  }, 60_000)

  it('runs host-only zero-thread runtimes', async () => {
    const fixture = await useFixture({ config: 'host-only' })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'host-only-start', 1)

    const events = await readRuntimeEvents(fixture.eventsFile)
    const start = events.find((event) => event.event === 'host-only-start')
    expect(start).toMatchObject({ threads: 0 })

    await neem.stop()
  }, 60_000)

  it('restarts the whole runtime after a host failure', async () => {
    const fixture = await useFixture({ config: 'host-fail-once' })
    const markerFile = resolve(fixture.dir, 'host-fail-once-marker')
    await rm(markerFile, { force: true })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_HOST_FAIL_ONCE_MARKER: markerFile,
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'host-fail-once-start', 2)
    await waitForEventCount(fixture.eventsFile, 'plugin-runtime-fail', 1)
    await waitForEventCount(fixture.eventsFile, 'plugin-runtime-ready', 2)

    await neem.stop()
  }, 60_000)

  it('restarts the whole runtime after a worker failure', async () => {
    const fixture = await useFixture({ config: 'fail-once' })
    const markerFile = resolve(fixture.dir, 'fail-once-marker')
    await rm(markerFile, { force: true })
    const neem = spawnTrackedNeem(
      ['dev', '--config', fixture.configFile, '--outDir', fixture.outDir],
      {
        env: {
          NEEM_FAIL_ONCE_MARKER: markerFile,
          NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile,
        },
      },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForEventCount(fixture.eventsFile, 'fail-once-start', 2)
    await waitForEventCount(fixture.eventsFile, 'plugin-runtime-fail', 1)
    await waitForEventCount(fixture.eventsFile, 'plugin-runtime-ready', 2)

    await neem.stop()
  }, 60_000)

  it('fails fast for unknown selected runtimes', async () => {
    const fixture = await useFixture()
    const neem = spawnNeem([
      'build',
      'missing',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toContain('Unknown Neem runtime(s): missing')
  }, 60_000)

  it('starts only selected dev runtimes', async () => {
    const fixture = await useFixture({ config: 'selection' })
    const neem = spawnTrackedNeem(
      [
        'dev',
        'jobs',
        '--config',
        fixture.configFile,
        '--outDir',
        fixture.outDir,
      ],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )

    await neem.waitForEvent((event) => event.event === 'runtime:ready', 30_000)
    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) => event.event === 'selection-start' && event.runtime === 'jobs',
      1,
    )

    const events = await readRuntimeEvents(fixture.eventsFile)
    expect(
      events.some(
        (event) => event.event === 'selection-start' && event.runtime === 'api',
      ),
    ).toBe(false)

    await neem.stop()
  }, 60_000)

  it('starts only the selected generated runtime wrapper', async () => {
    const fixture = await useFixture({ config: 'selection' })

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])

    const node = spawnTrackedNode(
      [resolve(fixture.outDir, 'runtimes/jobs/start.js')],
      { env: { NEEM_RUNTIME_EVENTS_FILE: fixture.eventsFile } },
    )
    await waitForMatchingEventCount(
      fixture.eventsFile,
      (event) => event.event === 'selection-start' && event.runtime === 'jobs',
      1,
    )

    const events = await readRuntimeEvents(fixture.eventsFile)
    expect(
      events.some(
        (event) => event.event === 'selection-start' && event.runtime === 'api',
      ),
    ).toBe(false)

    await node.stop()
  }, 60_000)

  it('fails fast when a production manifest contains invalid paths', async () => {
    const fixture = await useFixture()

    await runNeem([
      'build',
      '--config',
      fixture.configFile,
      '--outDir',
      fixture.outDir,
    ])
    const manifestFile = resolve(fixture.outDir, 'neem.manifest.json')
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'))
    manifest.runtime.worker.file = '../worker-entry.js'
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)

    const neem = spawnNeem(['start', '--outDir', fixture.outDir])
    const exit = await neem.waitForExit()

    expect(exit.code).not.toBe(0)
    expect(neem.stderr()).toMatch(
      /runtime[\s\S]*worker[\s\S]*file[\s\S]*Invalid input/,
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

async function waitForEventCount(
  file: string,
  eventName: string,
  count: number,
): Promise<void> {
  await waitForMatchingEventCount(
    file,
    (event) => event.event === eventName,
    count,
  )
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

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate local TCP port'))
        return
      }

      server.close((error) => {
        if (error) reject(error)
        else resolvePort(address.port)
      })
    })
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

async function waitForMetrics(
  port: number,
  neem: SpawnedNeem,
): Promise<string> {
  return await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`).catch(
        () => undefined,
      )
      if (response?.status !== 200) return false
      return await response.text()
    },
    30_000,
    () => formatSpawnedOutput(neem),
  )
}

function formatSpawnedOutput(neem: SpawnedNeem): string {
  return [`stdout:\n${neem.stdout()}`, `stderr:\n${neem.stderr()}`].join('\n')
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
