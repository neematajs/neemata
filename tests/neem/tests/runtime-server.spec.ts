import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { NeemRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'
import type { NeemNormalizedConfig } from '../../../packages/neem/src/public/config.ts'
import { createNeemHostHooks } from '../../../packages/neem/src/internal/runtime/hooks.ts'
import { NeemRuntimeServer } from '../../../packages/neem/src/internal/runtime/server.ts'
import { createRuntimeSnapshot } from '../../../packages/neem/src/internal/runtime/snapshot.ts'

describe('NeemRuntimeServer', () => {
  it('exposes snapshot metadata and marks start/stop state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-snapshot-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
    })

    expect(server.getSnapshot()).toMatchObject({
      mode: 'production',
      runtimeNames: ['hosted'],
      artifactCount: 2,
      state: 'idle',
      revision: 0,
    })

    await server.start()
    expect(server.getState()).toBe('running')

    await server.stop()
    expect(server.getState()).toBe('stopped')
  })

  it('reloads with a new snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-reload-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
    })

    await server.start()
    await server.reload(createRuntimeHostSnapshot(eventFile))

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      runtimeNames: ['hosted'],
    })
    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
    ])

    await server.stop()
  })

  it('marks failed runtime reload and recovers on next successful runtime reload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-reload-fail-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
    })

    await server.start()
    await expect(
      server.reloadRuntime(
        'hosted',
        createRuntimeHostSnapshot(eventFile, { failStart: true }),
      ),
    ).rejects.toThrow('host start failed')
    expect(server.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: expect.objectContaining({ message: 'host start failed' }),
    })

    await server.reloadRuntime('hosted', createRuntimeHostSnapshot(eventFile))

    expect(server.getSnapshot()).toMatchObject({
      state: 'running',
      lastError: undefined,
    })
    await server.stop()
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
    expect([...server.getRuntimeWorkers()]).toHaveLength(1)
    expect([...server.getProxyUpstreams()]).toMatchObject([
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

  it('serves public health and readiness probes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-health-'))
    const eventFile = join(dir, 'events.log')
    const port = await getFreePort()
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, { health: { port } }),
    })

    await server.start()
    try {
      const healthResponse = await fetch(`http://127.0.0.1:${port}/health`)
      const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`)
      const health = await healthResponse.json()
      const ready = await readyResponse.json()

      expect(healthResponse.status).toBe(200)
      expect(health).toMatchObject({
        ok: true,
        health: { state: 'running', ready: true },
      })
      expect(readyResponse.status).toBe(200)
      expect(ready).toMatchObject({
        ok: true,
        health: { state: 'running', ready: true },
      })
    } finally {
      await server.stop()
    }
  })

  it('reports failed readiness through the public probe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-health-fail-'))
    const eventFile = join(dir, 'events.log')
    const port = await getFreePort()
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        failPlan: true,
        health: { port },
      }),
    })

    await expect(server.start()).rejects.toThrow('host plan failed')
    try {
      const healthResponse = await fetch(`http://127.0.0.1:${port}/health`)
      const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`)

      expect(healthResponse.status).toBe(503)
      expect(await healthResponse.json()).toMatchObject({
        ok: false,
        health: {
          state: 'failed',
          ready: false,
          lastError: { message: 'host plan failed' },
        },
      })
      expect(readyResponse.status).toBe(503)
      expect(await readyResponse.json()).toMatchObject({
        ok: false,
        health: { state: 'failed', ready: false },
      })
    } finally {
      await server.stop()
    }
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

  it('uses config-derived default threads when host plan returns nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-default-plan-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        defaultPlan: true,
        threads: [
          { eventFile, upstreamUrl: 'http://127.0.0.1:3701/' },
          { eventFile, upstreamUrl: 'http://127.0.0.1:3702/' },
        ],
      }),
    })

    await server.start()
    await server.stop()

    const events = await readEvents(eventFile)
    expect(events.slice(0, 6)).toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:0',
      'worker-start:hosted:1',
      'host-start:2:2',
      'host-stop:2',
    ])
    expect(new Set(events.slice(6))).toEqual(
      new Set(['worker-stop:hosted:0', 'worker-stop:hosted:1']),
    )
  })

  it('validates final planned thread topology before startup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-topology-'))
    const duplicateEventFile = join(dir, 'duplicate-events.log')
    const emptyEventFile = join(dir, 'empty-events.log')

    await expect(
      new NeemRuntimeServer({
        snapshot: createRuntimeHostSnapshot(duplicateEventFile, {
          duplicateThreadName: true,
        }),
      }).start(),
    ).rejects.toThrow('duplicate thread name')

    await expect(
      new NeemRuntimeServer({
        snapshot: createRuntimeHostSnapshot(emptyEventFile, {
          emptyPlan: true,
        }),
      }).start(),
    ).rejects.toThrow('must plan at least one thread')
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
    expect([...server.getRuntimeWorkers()]).toEqual([])
    expect([...server.getProxyUpstreams()]).toEqual([])

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

  it('publishes scoped reload proxy upstreams after runtime host start', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-proxy-barrier-'))
    const eventFile = join(dir, 'events.log')
    const proxyPort = await getFreePort()
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, { proxyPort }),
    })

    await server.start()

    const reload = server.reloadRuntime(
      'hosted',
      createRuntimeHostSnapshot(eventFile, {
        proxyPort,
        hostStartDelayMs: 150,
      }),
    )
    await waitForEvents(eventFile, (events) => {
      return events.filter((event) => event === 'host-start:1:1').length === 2
    })
    await wait(25)

    expect([...server.getProxyUpstreams()]).toEqual([])

    await reload
    expect([...server.getProxyUpstreams()]).toMatchObject([
      {
        runtimeName: 'hosted',
        upstream: { type: 'http', url: 'http://127.0.0.1:3701/' },
      },
    ])

    await server.stop()
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

  it('restarts a production runtime after post-ready worker failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-worker-restart-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        failWorkerAfterStart: 1,
      }),
      failOnWorkerError: true,
      recovery: { attempts: 2, delayMs: 1, maxDelayMs: 1 },
    })

    await server.start()

    await waitForEvents(eventFile, (events) => {
      return events.filter((event) => event === 'host-start:1:1').length === 2
    })
    expect(server.getHealth()).toMatchObject({
      state: 'running',
      ready: true,
      runtimes: [{ name: 'hosted', pool: { state: 'ready', ready: 1 } }],
    })

    await server.stop()
  })

  it('marks host failed after worker restart exhaustion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-worker-exhaust-'))
    const eventFile = join(dir, 'events.log')
    const port = await getFreePort()
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        failWorkerAfterStart: true,
        health: { port },
      }),
      failOnWorkerError: true,
      recovery: { attempts: 1, delayMs: 1, maxDelayMs: 1 },
    })

    await server.start()

    await waitForEvents(eventFile, (events) => {
      return events.filter((event) => event === 'host-fail:1').length >= 2
    })
    await waitForHealth(server, (health) => health.state === 'failed')
    const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`)

    expect(server.getHealth()).toMatchObject({ state: 'failed', ready: false })
    expect(readyResponse.status).toBe(503)

    await server.stop()
  })

  it('reports degraded runtimes as not ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-worker-degraded-'))
    const eventFile = join(dir, 'events.log')
    const port = await getFreePort()
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile, {
        failWorkerAfterStart: true,
        extraStableWorker: true,
        health: { port },
      }),
      recovery: { attempts: 0 },
    })

    await server.start()

    await waitForHealth(server, (health) => {
      return health.runtimes.some(
        (runtime) => runtime.pool.state === 'degraded',
      )
    })
    const readyResponse = await fetch(`http://127.0.0.1:${port}/ready`)

    expect(server.getHealth()).toMatchObject({
      state: 'running',
      ready: false,
      runtimes: [{ name: 'hosted', pool: { state: 'degraded', ready: 1 } }],
    })
    expect(readyResponse.status).toBe(503)

    await server.stop()
  })

  it('serializes operations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'neem-runtime-serialize-'))
    const eventFile = join(dir, 'events.log')
    const server = new NeemRuntimeServer({
      snapshot: createRuntimeHostSnapshot(eventFile),
    })

    await Promise.all([
      server.start(),
      server.reload(createRuntimeHostSnapshot(eventFile)),
    ])

    expect(server.getState()).toBe('running')
    await server.stop()
    await expect(readEvents(eventFile)).resolves.toEqual([
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
      'host-setup:hosted',
      'host-plan:hosted',
      'worker-start:hosted:worker',
      'host-start:1:1',
      'host-stop:1',
      'worker-stop:hosted:worker',
    ])
  })
})

function createRuntimeHostSnapshot(
  eventFile: string,
  options: {
    failStart?: boolean
    failPlan?: boolean
    failStop?: boolean
    failFail?: boolean
    useResolvedArtifact?: boolean
    includeRuntime?: boolean
    failWorkerAfterStart?: boolean | number
    extraStableWorker?: boolean
    hostStartDelayMs?: number
    proxyPort?: number
    health?: NeemNormalizedConfig['health']
    defaultPlan?: boolean
    emptyPlan?: boolean
    duplicateThreadName?: boolean
    threadCount?: number
    threads?: number | readonly unknown[]
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
      health: options.health,
      proxy: options.proxyPort
        ? { hostname: '127.0.0.1', port: options.proxyPort }
        : undefined,
      runtimes: includeRuntime
        ? {
            hosted: {
              worker: { entry: './runtime-host.worker.js' },
              host: { entry: './runtime-host.host.js' },
              options: {
                eventFile,
                upstreamUrl: 'http://127.0.0.1:3701/',
                failStart: options.failStart,
                failPlan: options.failPlan,
                failStop: options.failStop,
                failFail: options.failFail,
                useResolvedArtifact: options.useResolvedArtifact,
                failWorkerAfterStart: options.failWorkerAfterStart,
                extraStableWorker: options.extraStableWorker,
                hostStartDelayMs: options.hostStartDelayMs,
                defaultPlan: options.defaultPlan,
                emptyPlan: options.emptyPlan,
                duplicateThreadName: options.duplicateThreadName,
                threadCount: options.threadCount,
              },
              threads: options.threads,
            },
          }
        : {},
    } as NeemNormalizedConfig,
    manifest: {
      schemaVersion: 1,
      config: {
        proxy: options.proxyPort
          ? { hostname: '127.0.0.1', port: options.proxyPort }
          : undefined,
        runtimes: {},
      },
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

async function getFreePort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to allocate test port')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  return address.port
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

async function waitForHealth(
  server: NeemRuntimeServer,
  predicate: (health: ReturnType<NeemRuntimeServer['getHealth']>) => boolean,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 5_000) {
    if (predicate(server.getHealth())) return
    await wait(25)
  }
  throw new Error('Timed out waiting for runtime health')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function toManifestPath(outDir: string, file: string): string {
  const path = relative(outDir, file).replace(/\\/g, '/')
  return path || '.'
}
