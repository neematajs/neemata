import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { NeemBuildManifest } from '../../../packages/neem/src/internal/build/manifest.ts'
import type { NeemRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'
import type { NeemConfig } from '../../../packages/neem/src/public/config.ts'
import { createNeemHostHooks } from '../../../packages/neem/src/internal/runtime/hooks.ts'
import { NeemRuntimeServer } from '../../../packages/neem/src/internal/runtime/server.ts'
import { createRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'

describe('NeemRuntimeServer', () => {
  it('exposes snapshot metadata and marks start/stop state', async () => {
    const server = new TestRuntimeServer({ snapshot: createSnapshot('api') })

    expect(server.getSnapshot()).toMatchObject({
      mode: 'production',
      outDir: '/tmp/neem-out',
      runtimeNames: ['api'],
      artifactCount: 1,
      state: 'idle',
      revision: 0,
    })

    await server.start()
    expect(server.getState()).toBe('running')

    await server.stop()
    expect(server.getState()).toBe('stopped')
  })

  it('reloads with a new snapshot', async () => {
    const events: string[] = []
    const server = new TestRuntimeServer({
      snapshot: createSnapshot('api'),
      events,
    })

    await server.start()
    await server.reload(createSnapshot('admin'))

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      runtimeNames: ['admin'],
    })
    expect(events).toEqual([
      'start:/tmp/neem-out',
      'stop:/tmp/neem-out',
      'start:/tmp/neem-out',
    ])
  })

  it('reloads one runtime without full server restart', async () => {
    const events: string[] = []
    const server = new TestRuntimeServer({
      snapshot: createSnapshot('api'),
      events,
    })

    await server.start()
    await server.reloadRuntime('api', createSnapshot('api'))

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      runtimeNames: ['api'],
    })
    expect(events).toEqual(['start:/tmp/neem-out', 'reload-runtime:api'])
  })

  it('marks failed runtime reload and recovers on next successful runtime reload', async () => {
    const error = new Error('fixture runtime reload failure')
    const events: string[] = []
    const server = new TestRuntimeServer({
      snapshot: createSnapshot('api'),
      events,
    })

    await server.start()
    server.startError = error

    await expect(
      server.reloadRuntime('api', createSnapshot('api')),
    ).rejects.toThrow(error)
    expect(server.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: error,
    })

    server.startError = undefined
    await server.reloadRuntime('api', createSnapshot('api'))

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      lastError: undefined,
    })
    expect(events).toEqual([
      'start:/tmp/neem-out',
      'reload-runtime:api',
      'reload-runtime:api',
    ])
  })

  it('marks failed state when start fails', async () => {
    const error = new Error('fixture start failure')
    const server = new TestRuntimeServer({
      snapshot: createSnapshot('api'),
      startError: error,
    })

    await expect(server.start()).rejects.toThrow(error)
    expect(server.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: error,
    })
  })

  it('runs runtime host setup/plan/start/stop on the main thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-host-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
    })

    await server.start()

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      runtimeNames: ['hosted'],
    })
    expect(server.getRuntimeWorkers()).toHaveLength(1)
    expect(server.getProxyUpstreams()).toMatchObject([
      {
        runtimeName: 'hosted',
        upstream: { type: 'http', url: 'http://127.0.0.1:3701/' },
      },
    ])

    await server.stop()

    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
    ])
  })

  it('allows runtime hosts to plan threads with resolved artifacts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-host-artifact-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        useResolvedArtifact: true,
      }),
    })

    await server.start()
    await server.stop()

    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
    ])
  })

  it('allows observers to receive server/runtime/worker lifecycle hooks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-hooks-'))
    const eventFile = join(dir, 'events.log')
    const hooks = createNeemHostHooks()
    const hookEvents: string[] = []
    hooks.addHooks({
      server: {
        start() {
          hookEvents.push('nested-server:start')
        },
      },
    })
    hooks.hook('server:start', () => {
      hookEvents.push('server:start')
    })
    hooks.hook('server:ready', () => {
      hookEvents.push('server:ready')
    })
    hooks.hook('runtime:start', (event) => {
      hookEvents.push(`runtime:start:${event.name}`)
    })
    hooks.hook('runtime:ready', (event) => {
      hookEvents.push(`runtime:ready:${event.name}:${event.upstreams?.length}`)
    })
    hooks.hook('worker:start', (event) => {
      hookEvents.push(`worker:start:${event.name}`)
    })
    hooks.hook('worker:ready', (event) => {
      hookEvents.push(`worker:ready:${event.name}`)
    })

    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
      hooks,
    })

    await server.start()
    await server.stop()

    expect(hookEvents).toEqual([
      'nested-server:start',
      'server:start',
      'runtime:start:hosted',
      'worker:start:hosted:worker',
      'worker:ready:hosted:worker',
      'runtime:ready:hosted:1',
      'server:ready',
    ])
  })

  it('notifies observers after scoped runtime reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-reload-hook-'))
    const eventFile = join(dir, 'events.log')
    const hooks = createNeemHostHooks()
    const hookEvents: string[] = []
    hooks.hook('runtime:reload', (event) => {
      hookEvents.push(`runtime:reload:${event.name}:${event.upstreams?.length}`)
    })

    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
      hooks,
    })

    await server.start()
    await server.reloadRuntime('hosted', createRuntimeHostSnapshot(eventFile))
    await server.reloadRuntime(
      'hosted',
      createRuntimeHostSnapshot(eventFile, { includeRuntime: false }),
    )
    await server.stop()

    expect(hookEvents).toEqual([
      'runtime:reload:hosted:1',
      'runtime:reload:hosted:0',
    ])
  })

  it('logs and ignores lifecycle hook failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-hook-fail-'))
    const eventFile = join(dir, 'events.log')
    const hooks = createNeemHostHooks()
    const hookEvents: string[] = []
    hooks.hook('worker:start', () => {
      throw new Error('observer failed')
    })
    hooks.hook('worker:ready', (event) => {
      hookEvents.push(`worker:ready:${event.name}`)
    })

    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
      hooks,
    })

    await server.start()

    expect(server.getState()).toBe('running')
    expect(hookEvents).toEqual(['worker:ready:hosted:worker'])

    await server.stop()
  })

  it('removes a runtime through scoped reload when it disappears from manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-host-remove-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
    })

    await server.start()
    await server.reloadRuntime(
      'hosted',
      createRuntimeHostSnapshot(eventFile, { includeRuntime: false }),
    )

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      runtimeNames: [],
    })
    expect(server.getRuntimeWorkers()).toEqual([])
    expect(server.getProxyUpstreams()).toEqual([])

    await server.stop()

    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
    ])
  })

  it('fails host startup during planning and runs cleanup hooks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-host-plan-fail-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, { failPlan: true }),
    })

    await expect(server.start()).rejects.toThrow('host plan failed')

    expect(server.getHealth()).toMatchObject({
      state: 'failed',
      ready: false,
      lastError: expect.objectContaining({ message: 'host plan failed' }),
    })
    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'host-fail:0',
      'host-stop:0',
    ])
  })

  it('fails host startup after thread readiness and stops planned threads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-host-fail-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, { failStart: true }),
    })

    await expect(server.start()).rejects.toThrow('host start failed')

    expect(server.getHealth()).toMatchObject({
      state: 'failed',
      ready: false,
      lastError: expect.objectContaining({ message: 'host start failed' }),
    })
    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-fail:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
    ])
  })

  it('stops runtime threads even when host stop fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-host-stop-fail-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, { failStop: true }),
    })

    await server.start()
    await expect(server.stop()).rejects.toThrow('host stop failed')

    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
    ])
  })

  it('cleans up runtime threads when host fail handler throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-host-fail-fail-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        failStart: true,
        failFail: true,
      }),
    })

    await expect(server.start()).rejects.toThrow('host start failed')

    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-fail:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
    ])
  })

  it('notifies runtime host fail handler after post-ready worker failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-worker-fail-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        failWorkerAfterStart: true,
      }),
    })

    await server.start()

    await waitForEvents(eventFile, (events) => events.includes('host-fail:1'))
    expect(server.getHealth()).toMatchObject({
      state: 'running',
      ready: false,
      runtimes: [{ name: 'hosted', pool: { state: 'failed', failed: 1 } }],
    })

    await server.stop()
  })

  it('serializes operations', async () => {
    const events: string[] = []
    const server = new TestRuntimeServer({
      snapshot: createSnapshot('api'),
      events,
      delayMs: 10,
    })

    await Promise.all([server.start(), server.reload(createSnapshot('admin'))])

    expect(events).toEqual([
      'start:/tmp/neem-out',
      'stop:/tmp/neem-out',
      'start:/tmp/neem-out',
    ])
  })
})

class TestRuntimeServer extends NeemRuntimeServer {
  private readonly events: string[]
  startError: Error | undefined
  private readonly delayMs: number

  constructor(options: {
    snapshot: NeemRuntimeSnapshot
    events?: string[]
    startError?: Error
    delayMs?: number
  }) {
    super({ snapshot: options.snapshot })
    this.events = options.events ?? []
    this.startError = options.startError
    this.delayMs = options.delayMs ?? 0
  }

  protected override async startRuntime(
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    if (this.delayMs) await wait(this.delayMs)
    if (this.startError) throw this.startError
    this.events.push(`start:${snapshot.outDir}`)
  }

  protected override async stopRuntime(
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    this.events.push(`stop:${snapshot.outDir}`)
  }

  protected override async reloadRuntimeRuntime(
    runtimeName: string,
    _snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    this.events.push(`reload-runtime:${runtimeName}`)
    if (this.startError) throw this.startError
  }
}

function createSnapshot(
  runtimeName: string,
  options: { runtimes?: boolean } = {},
): NeemRuntimeSnapshot {
  return createRuntimeSnapshot({
    mode: 'production',
    outDir: '/tmp/neem-out',
    config: { runtimes: {} } as NeemConfig,
    manifest: createManifest(runtimeName, options.runtimes !== false),
  })
}

function createManifest(
  runtimeName: string,
  includeRuntimes = true,
): NeemBuildManifest {
  return {
    schemaVersion: 1,
    config: { file: 'config/entry/neem.config.js' },
    runtimes: includeRuntimes
      ? {
          [runtimeName]: {
            name: runtimeName,
            entry: {
              id: 'entry',
              kind: 'worker',
              owner: { type: 'runtime', name: runtimeName },
              file: `runtimes/${runtimeName}/entry/${runtimeName}.js`,
              outDir: `runtimes/${runtimeName}/entry`,
            },
            artifacts: [],
          },
        }
      : {},
  }
}

function createRuntimeHostSnapshot(
  eventFile: string,
  options: {
    failStart?: boolean
    failPlan?: boolean
    failStop?: boolean
    failFail?: boolean
    useResolvedArtifact?: boolean
    includeRuntime?: boolean
    failWorkerAfterStart?: boolean
  } = {},
): NeemRuntimeSnapshot {
  const hostFile = fileURLToPath(
    new URL('../fixtures/runtime-host.host.js', import.meta.url),
  )
  const workerFile = fileURLToPath(
    new URL('../fixtures/runtime-host.worker.js', import.meta.url),
  )
  const outDir = dirname(workerFile)
  const workerEntry = fileURLToPath(
    new URL(
      '../../../packages/neem/src/internal/runtime/worker-entry.ts',
      import.meta.url,
    ),
  )
  const configFile = fileURLToPath(
    new URL('../fixtures/runtime-host.config.js', import.meta.url),
  )

  const includeRuntime = options.includeRuntime !== false

  return createRuntimeSnapshot({
    mode: 'production',
    outDir,
    runtimeWorkerEntry: workerEntry,
    configFile,
    config: {
      runtimes: includeRuntime
        ? {
            hosted: {
              entry: async () => ({ default: {} as never }),
              host: async () => ({ default: {} as never }),
              options: {
                eventFile,
                upstreamUrl: 'http://127.0.0.1:3701/',
                failStart: options.failStart,
                failPlan: options.failPlan,
                failStop: options.failStop,
                failFail: options.failFail,
                useResolvedArtifact: options.useResolvedArtifact,
                failWorkerAfterStart: options.failWorkerAfterStart,
              },
            },
          }
        : {},
    } as NeemConfig,
    manifest: {
      schemaVersion: 1,
      config: { file: 'config/entry/neem.config.js' },
      runtimes: includeRuntime
        ? {
            hosted: {
              name: 'hosted',
              entry: {
                id: 'entry',
                kind: 'worker',
                owner: { type: 'runtime', name: 'hosted' },
                file: toManifestPath(outDir, workerFile),
                outDir: toManifestPath(outDir, dirname(workerFile)),
              },
              host: {
                id: 'host',
                kind: 'module',
                owner: { type: 'runtime', name: 'hosted' },
                file: toManifestPath(outDir, hostFile),
                outDir: toManifestPath(outDir, dirname(hostFile)),
              },
              artifacts: [],
            },
          }
        : {},
    },
  })
}

async function readEvents(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).trim().split('\n')
}

async function waitForEvents(
  file: string,
  predicate: (events: string[]) => boolean,
): Promise<string[]> {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    const events = await readEvents(file).catch(() => [])
    if (predicate(events)) return events
    await wait(25)
  }
  throw new Error('Timed out waiting for runtime events')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toManifestPath(outDir: string, file: string): string {
  const path = relative(outDir, file).replace(/\\/g, '/')
  return path || '.'
}
