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
const tempRoot = resolve(import.meta.dirname, '../.tmp-start')
const tempDirs: string[] = []
const previousEventsFile = process.env.NEEM_RUNTIME_EVENTS_FILE
const previousLogEventsFile = process.env.NEEM_LOG_EVENTS_FILE

describe('neem start', () => {
  afterEach(async () => {
    if (previousEventsFile === undefined) {
      delete process.env.NEEM_RUNTIME_EVENTS_FILE
    } else {
      process.env.NEEM_RUNTIME_EVENTS_FILE = previousEventsFile
    }
    if (previousLogEventsFile === undefined) {
      delete process.env.NEEM_LOG_EVENTS_FILE
    } else {
      process.env.NEEM_LOG_EVENTS_FILE = previousLogEventsFile
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
    const runtimeSource = await readFile(
      resolve(neemInternalDir, 'runtime/runtime.ts'),
      'utf8',
    )

    expect(startSource).not.toContain('app-worker-entry')
    expect(startSource).not.toContain('createAppWorkerSource')
    expect(startSource).not.toContain('eval: true')
    expect(runtimeSource).toContain('resolveRuntimeWorkerEntry')
    expect(runtimeSource).not.toContain('eval: true')
    expect(workerSource).toContain('createWorkerRuntime')
    expect(workerSource).toContain('mode: data.mode')
    expect(workerSource).not.toContain("mode: 'production'")
  })

  it('starts built runtime worker threads and stops runtimes', async () => {
    const { outDir, eventsFile } = await buildFixture('runtime.config.ts')
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    const host = await startNeem({ outDir })

    try {
      expect(host.getRuntimeWorkers()).toHaveLength(2)
      expect(host.getRuntimeWorkerPools()).toHaveLength(1)
      expect(host.getRuntimeWorkerPools()[0]?.getHealth()).toMatchObject({
        name: 'runtime:api',
        size: 2,
        ready: 2,
        state: 'ready',
      })
      expect(host.getHealth()).toMatchObject({
        state: 'running',
        ready: true,
        runtimes: [
          {
            name: 'api',
            pool: { state: 'ready', size: 2, ready: 2 },
            threads: [
              expect.objectContaining({ name: 'api:0', state: 'ready' }),
              expect.objectContaining({ name: 'api:1', state: 'ready' }),
            ],
          },
        ],
        proxy: { enabled: false, running: false },
      })
      expect(
        host
          .getRuntimeWorkers()
          .map((worker) => ({ name: worker.name, state: worker.getState() })),
      ).toEqual([
        { name: 'api:0', state: 'ready' },
        { name: 'api:1', state: 'ready' },
      ])

      expect(host.getUpstreams()).toEqual([
        { type: 'http', url: 'http://127.0.0.1:4101/api:0' },
        { type: 'http', url: 'http://127.0.0.1:4102/api:1' },
      ])
      expect(
        host
          .getProxyUpstreams()
          .toSorted((a, b) => a.proxyUpstream.port - b.proxyUpstream.port),
      ).toEqual([
        expect.objectContaining({
          runtimeName: 'api',
          count: 1,
          proxyUpstream: expect.objectContaining({
            type: 'port',
            transport: 'http',
            hostname: '127.0.0.1',
            port: 4101,
          }),
        }),
        expect.objectContaining({
          runtimeName: 'api',
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
        .toSorted((a, b) => String(a.name).localeCompare(String(b.name)))
      expect(createEvents).toHaveLength(2)
      expect(createEvents[0]).toMatchObject({
        mode: 'production',
        name: 'api:0',
        data: { label: 'one' },
        logger: true,
        artifact: { id: 'entry', owner: { type: 'runtime', name: 'api' } },
      })
    } finally {
      await host.stop()
      await host.closed
    }

    const stopEvents = (await readEvents(eventsFile)).filter(
      (event) => event.event === 'stop',
    )
    expect(stopEvents.map((event) => event.name).toSorted()).toEqual([
      'api:0',
      'api:1',
    ])
  })

  it('starts Neemata application entries through the application package adapter', async () => {
    const { outDir } = await buildFixture('neem.config.ts')

    const host = await startNeem({ outDir })

    try {
      expect(host.getRuntimeWorkers()).toHaveLength(1)
      expect(host.getRuntimeWorkerPools()).toHaveLength(1)
      expect(host.getRuntimeWorkers()[0]?.getState()).toBe('ready')
      expect(host.getUpstreams()).toEqual([
        { type: 'http', url: 'http://127.0.0.1:3000' },
      ])
    } finally {
      await host.stop()
      await host.closed
    }
  })

  it('starts generic runtimes and passes host-managed thread ports', async () => {
    const { outDir, eventsFile } = await buildFixture(
      'generic-runtime.config.ts',
    )
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    const host = await startNeem({ outDir })

    try {
      expect(host.getRuntimeWorkers()).toHaveLength(4)
      expect(host.getRuntimeWorkerPools()).toHaveLength(2)
      expect(host.getHealth()).toMatchObject({
        state: 'running',
        ready: true,
        runtimeNames: ['api', 'jobs'],
        runtimes: [
          { name: 'api', pool: { state: 'ready', size: 2, ready: 2 } },
          { name: 'jobs', pool: { state: 'ready', size: 2, ready: 2 } },
        ],
      })
      expect(host.getUpstreams()).toEqual([
        { type: 'http', url: 'http://127.0.0.1:4201/api:0' },
        { type: 'http', url: 'http://127.0.0.1:4202/api:1' },
      ])
      await waitForEvent(
        eventsFile,
        (event) =>
          event.event === 'runtime-message' &&
          event.message?.type === 'host-ready',
      )
    } finally {
      await host.stop()
      await host.closed
    }

    const events = await readEvents(eventsFile)
    expect(
      events.some(
        (event) =>
          event.event === 'host-setup' &&
          event.name === 'jobs' &&
          event.options?.queue === 'runtime' &&
          event.artifact?.id === 'entry' &&
          event.artifact.owner.type === 'runtime' &&
          event.artifact.owner.name === 'jobs' &&
          event.hostArtifact?.id === 'host' &&
          event.hostArtifact.owner.type === 'runtime' &&
          event.hostArtifact.owner.name === 'jobs',
      ),
    ).toBe(true)
    expect(events.some((event) => event.event === 'host-plan')).toBe(true)
    expect(
      events.some(
        (event) =>
          event.event === 'host-start' &&
          JSON.stringify(event.threads) ===
            JSON.stringify(['worker:0', 'worker:1']),
      ),
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.event === 'runtime-message' &&
          event.message?.type === 'host-ready',
      ),
    ).toBe(true)
    expect(
      events.some(
        (event) =>
          event.event === 'host-stop' &&
          JSON.stringify(event.threads) ===
            JSON.stringify(['worker:0', 'worker:1']),
      ),
    ).toBe(true)
  })

  it('starts only selected generic runtimes', async () => {
    const { outDir, eventsFile } = await buildFixture(
      'generic-runtime.config.ts',
    )
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    const host = await startNeem({ outDir, runtimes: ['api'] })

    try {
      expect(host.getRuntimeWorkers()).toHaveLength(2)
      expect(host.getRuntimeWorkerPools()).toHaveLength(1)
      expect(host.getHealth()).toMatchObject({
        state: 'running',
        ready: true,
        runtimeNames: ['api'],
        runtimes: [
          { name: 'api', pool: { state: 'ready', size: 2, ready: 2 } },
        ],
      })
      expect(host.getUpstreams()).toEqual([
        { type: 'http', url: 'http://127.0.0.1:4201/api:0' },
        { type: 'http', url: 'http://127.0.0.1:4202/api:1' },
      ])
    } finally {
      await host.stop()
      await host.closed
    }

    const events = await readEvents(eventsFile)
    expect(events.some((event) => event.name === 'jobs')).toBe(false)
    expect(events.some((event) => event.event === 'host-setup')).toBe(false)
  })

  it('fails startup and stops workers that already started', async () => {
    const { outDir, eventsFile } = await buildFixture(
      'runtime-fail-start.config.ts',
    )
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    await expect(startNeem({ outDir })).rejects.toThrow(
      'fixture start failure api:1',
    )
    await waitForEvent(
      eventsFile,
      (event) => event.event === 'stop' && event.name === 'api:1',
    )

    const events = await readEvents(eventsFile)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'stop', name: 'api:0' }),
    )
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'stop', name: 'api:1' }),
    )
  })

  it('treats post-start worker failure as fatal for the host', async () => {
    const { outDir, eventsFile } = await buildFixture(
      'runtime-fail-after-start.config.ts',
    )
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    const host = await startNeem({ outDir })

    await expect(host.closed).rejects.toThrow('fixture runtime failure api:1')

    const events = await readEvents(eventsFile)
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'stop', name: 'api:0' }),
    )
  })

  it('logs build/start/runtime lifecycle through configured logger', async () => {
    await mkdir(tempRoot, { recursive: true })
    const outDir = await mkdtemp(resolve(tempRoot, 'neem-start-logs-'))
    tempDirs.push(outDir)
    const logFile = resolve(outDir, 'logs.jsonl')
    const eventsFile = resolve(outDir, 'events.jsonl')
    process.env.NEEM_LOG_EVENTS_FILE = logFile
    process.env.NEEM_RUNTIME_EVENTS_FILE = eventsFile

    await buildNeem({
      config: resolve(fixturesDir, 'runtime.config.ts'),
      outDir,
    })
    const host = await startNeem({ outDir })

    try {
      expect(host.getRuntimeWorkers()).toHaveLength(2)
    } finally {
      await host.stop()
      await host.closed
    }

    const logs = await readLogs(logFile)
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          $label: 'Fixture',
          msg: 'Starting Neem from built output',
        }),
        expect.objectContaining({
          $label: 'api:0',
          msg: 'Creating Neem worker runtime',
        }),
        expect.objectContaining({
          $label: 'api:0',
          msg: 'Neem runtime started',
        }),
      ]),
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

async function readLogs(file: string): Promise<Array<Record<string, unknown>>> {
  const content = await readFile(file, 'utf8')
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function waitForEvent(
  file: string,
  predicate: (event: RuntimeEvent) => boolean,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 5000) {
    if ((await readEvents(file)).some(predicate)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for runtime event`)
}

type RuntimeEvent = {
  event: string
  name?: string
  mode?: string
  runtimeName?: string
  threadIndex?: number
  data?: Record<string, unknown>
  options?: Record<string, unknown>
  artifact?: { id: string; owner: Record<string, unknown> }
  hostArtifact?: { id: string; owner: Record<string, unknown> }
  artifacts: Array<{ id: string }>
  threads?: string[]
  message?: Record<string, unknown>
}
