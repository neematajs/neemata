import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { NEEM_MANIFEST_FILE } from '../../../packages/neem/src/internal/build/manifest.ts'
import { buildNeem } from '../../../packages/neem/src/internal/commands/build.ts'
import { startNeem } from '../../../packages/neem/src/internal/commands/start.ts'

const fixturesDir = resolve(import.meta.dirname, '../fixtures')
const neemInternalDir = resolve(
  import.meta.dirname,
  '../../../packages/neem/src/internal',
)
const tempRoot = resolve(import.meta.dirname, '../node_modules/.tmp')
const tempDirs: string[] = []
const previousEventsFile = process.env.NEEM_RUNTIME_EVENTS_FILE

describe('neem start', () => {
  afterEach(async () => {
    if (previousEventsFile === undefined) {
      delete process.env.NEEM_RUNTIME_EVENTS_FILE
    } else {
      process.env.NEEM_RUNTIME_EVENTS_FILE = previousEventsFile
    }

    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('uses package worker entry instead of eval source', async () => {
    const startSource = await readFile(
      resolve(neemInternalDir, 'commands/start.ts'),
      'utf8',
    )
    const workerSource = await readFile(
      resolve(neemInternalDir, 'runtime/worker-entry.ts'),
      'utf8',
    )
    const appRuntimeSource = await readFile(
      resolve(neemInternalDir, 'runtime/app.ts'),
      'utf8',
    )

    expect(startSource).not.toContain('app-worker-entry')
    expect(startSource).not.toContain('createAppWorkerSource')
    expect(startSource).not.toContain('eval: true')
    expect(appRuntimeSource).toContain('resolveRuntimeWorkerEntry')
    expect(appRuntimeSource).not.toContain('eval: true')
    expect(workerSource).toContain('createAppRuntime')
    expect(workerSource).toContain('mode: data.mode')
    expect(workerSource).not.toContain("mode: 'production'")
  })

  it('starts built app worker threads and stops app runtimes', async () => {
    const { outDir, eventsFile } = await buildFixture('runtime.config.ts')
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    const manifest = JSON.parse(
      await readFile(resolve(outDir, NEEM_MANIFEST_FILE), 'utf8'),
    ) as { config: { file: string } }
    const configCode = await readFile(
      resolve(outDir, manifest.config.file),
      'utf8',
    )
    expect(configCode).toContain('import("./runtime-app.ts")')

    const host = await startNeem({ outDir })

    try {
      expect(host.getWorkers()).toHaveLength(2)
      expect(host.getWorkerPools()).toHaveLength(1)
      expect(host.getWorkerPools()[0]?.getHealth()).toMatchObject({
        name: 'app:api',
        size: 2,
        ready: 2,
        state: 'ready',
      })
      expect(
        host
          .getWorkers()
          .map((worker) => ({
            appName: worker.appName,
            threadIndex: worker.threadIndex,
            state: worker.getState(),
          })),
      ).toEqual([
        { appName: 'api', threadIndex: 0, state: 'ready' },
        { appName: 'api', threadIndex: 1, state: 'ready' },
      ])

      expect(host.getUpstreams()).toEqual([
        { type: 'http', url: 'http://127.0.0.1:4101/api/0' },
        { type: 'http', url: 'http://127.0.0.1:4102/api/1' },
      ])
      expect(
        host
          .getProxyUpstreams()
          .toSorted((a, b) => a.proxyUpstream.port - b.proxyUpstream.port),
      ).toEqual([
        expect.objectContaining({
          appName: 'api',
          count: 1,
          proxyUpstream: expect.objectContaining({
            type: 'port',
            transport: 'http',
            hostname: '127.0.0.1',
            port: 4101,
          }),
        }),
        expect.objectContaining({
          appName: 'api',
          count: 1,
          proxyUpstream: expect.objectContaining({
            type: 'port',
            transport: 'http',
            hostname: '127.0.0.1',
            port: 4102,
          }),
        }),
      ])

      const createEvents = (await readEvents(eventsFile))
        .filter((event) => event.event === 'create')
        .toSorted((a, b) => (a.threadIndex ?? 0) - (b.threadIndex ?? 0))
      const pluginEvents = (await readEvents(eventsFile)).filter((event) =>
        event.event.startsWith('plugin-'),
      )
      expect(host.getPlugins()).toHaveLength(1)
      expect(pluginEvents).toContainEqual(
        expect.objectContaining({
          event: 'plugin-setup',
          mode: 'production',
          name: 'jobs',
          instanceId: 0,
          options: { queue: 'runtime' },
          logger: true,
        }),
      )
      expect(createEvents).toHaveLength(2)
      expect(createEvents[0]).toMatchObject({
        mode: 'production',
        appName: 'api',
        threadIndex: 0,
        threadOptions: { label: 'one' },
        logger: true,
        artifact: { id: 'entry', owner: { type: 'app', name: 'api' } },
      })
      expect(
        createEvents[0].artifacts.some(
          (artifact) => artifact.id === 'job-worker',
        ),
      ).toBe(true)
    } finally {
      await host.stop()
      await host.closed
    }

    const stopEvents = (await readEvents(eventsFile)).filter(
      (event) => event.event === 'stop',
    )
    expect(stopEvents.map((event) => event.threadIndex).toSorted()).toEqual([
      0, 1,
    ])
    expect(await readEvents(eventsFile)).toContainEqual(
      expect.objectContaining({
        event: 'plugin-stop',
        mode: 'production',
        name: 'jobs',
        instanceId: 0,
      }),
    )
  })

  it('starts Neemata application entries through the application package adapter', async () => {
    const { outDir } = await buildFixture('neem.config.ts')

    const host = await startNeem({ outDir })

    try {
      expect(host.getWorkers()).toHaveLength(1)
      expect(host.getWorkerPools()).toHaveLength(1)
      expect(host.getWorkers()[0]?.getState()).toBe('ready')
      expect(host.getUpstreams()).toEqual([
        { type: 'http', url: 'http://127.0.0.1:3000' },
      ])
    } finally {
      await host.stop()
      await host.closed
    }
  })

  it('fails startup and stops workers that already started', async () => {
    const { outDir, eventsFile } = await buildFixture(
      'runtime-fail-start.config.ts',
    )
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    await expect(startNeem({ outDir })).rejects.toThrow(
      'fixture start failure 1',
    )

    const events = await readEvents(eventsFile)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'stop', threadIndex: 0 }),
    )
  })

  it('treats post-start worker failure as fatal for the host', async () => {
    const { outDir, eventsFile } = await buildFixture(
      'runtime-fail-after-start.config.ts',
    )
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    const host = await startNeem({ outDir })

    await expect(host.closed).rejects.toThrow('fixture runtime failure 1')

    const events = await readEvents(eventsFile)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'stop', threadIndex: 0 }),
    )
  })
})

async function buildFixture(config: string) {
  await mkdir(tempRoot, { recursive: true })
  const outDir = await mkdtemp(resolve(tempRoot, 'neem-start-'))
  tempDirs.push(outDir)
  await buildNeem({ config: resolve(fixturesDir, config), outDir })
  return { outDir, eventsFile: resolve(outDir, 'events.jsonl') }
}

async function readEvents(file: string): Promise<RuntimeEvent[]> {
  const content = await readFile(file, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RuntimeEvent)
}

type RuntimeEvent = {
  event: string
  mode?: string
  appName?: string
  threadIndex?: number
  threadOptions?: Record<string, unknown>
  artifact?: { id: string; owner: Record<string, unknown> }
  artifacts: Array<{ id: string }>
}
