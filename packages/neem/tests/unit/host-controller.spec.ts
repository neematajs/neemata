import type { Future } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OperationScope } from '../../src/internal/host/lifecycle.ts'
import type { Manifest } from '../../src/internal/manifest/manifest.ts'
import type { NeemRuntimeState } from '../../src/shared/types.ts'
import { HostController } from '../../src/internal/host/controller.ts'
import { createRuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
import { PluginEnvironment } from '../../src/internal/plugins/environment.ts'
import { createHostHooks } from '../../src/internal/plugins/hooks.ts'

// Control runtime readiness; the controller's hooks and operation queue are
// real. The mock honours the start scope the way RuntimeController does.
const runtime = vi.hoisted(() => ({
  starts: [] as string[],
  patch: vi.fn(),
  stop: vi.fn<(scope: OperationScope) => Promise<void>>(),
  state: 'idle' as NeemRuntimeState,
  lastError: undefined as Error | undefined,
  onFailure: undefined as undefined | ((error: Error) => void),
  onStateChange: undefined as undefined | (() => void),
  ready: undefined as undefined | Future<void>,
}))

const proxy = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  publishHealth: vi.fn<() => void>(),
  setUpstreams: vi.fn<() => Promise<void>>(),
  getHealthStatus: undefined as
    | undefined
    | (() => { healthy: boolean; ready: boolean }),
}))

vi.mock('../../src/internal/host/runtime.ts', () => ({
  RuntimeController: class {
    name = 'api'
    constructor(options: {
      onFailure?: (error: Error) => void
      onStateChange?: () => void
    }) {
      runtime.onFailure = options.onFailure
      runtime.onStateChange = options.onStateChange
    }
    async start(scope: OperationScope) {
      runtime.starts.push('start')
      runtime.state = 'starting'
      await scope.wait(runtime.ready!.promise)
      runtime.state = 'ready'
    }
    stop(scope: OperationScope) {
      runtime.state = 'stopped'
      return runtime.stop(scope)
    }
    applyPatch = runtime.patch
    getUpstreams = () => []
    getState = () => runtime.state
    getLastError = () => runtime.lastError
    getHealth = () => ({
      name: 'api',
      ready: runtime.state === 'ready',
      state: runtime.state,
      pool: {},
      threads: [],
    })
  },
}))

vi.mock('../../src/internal/host/proxy.ts', () => ({
  ProxyController: class {
    constructor(
      _snapshot: unknown,
      options: { getHealthStatus?: () => { healthy: boolean; ready: boolean } },
    ) {
      proxy.getHealthStatus = options.getHealthStatus
    }
    start = proxy.start
    stop = proxy.stop
    publishHealth = proxy.publishHealth
    setUpstreams = proxy.setUpstreams
    getHealth = () => ({ enabled: true, ready: true })
  },
}))

afterEach(() => {
  runtime.starts.length = 0
  runtime.ready = undefined
  runtime.onFailure = undefined
  runtime.onStateChange = undefined
  runtime.state = 'idle'
  runtime.lastError = undefined
  runtime.patch.mockReset()
  runtime.stop.mockReset()
  proxy.start.mockReset()
  proxy.stop.mockReset()
  proxy.publishHealth.mockReset()
  proxy.setUpstreams.mockReset()
  proxy.getHealthStatus = undefined
  vi.restoreAllMocks()
})

const owner = { type: 'runtime' as const, name: 'api' }
const artifact = (id: string, kind: 'module' | 'worker') => ({
  id,
  kind,
  owner,
  file: `${id}.mjs`,
  outDir: '.',
})
const manifest: Manifest = {
  schemaVersion: 4,
  runtime: {
    entry: 'start.js',
    start: artifact('start', 'module'),
    worker: artifact('worker-entry', 'worker'),
    runner: artifact('runner-entry', 'worker'),
  },
  config: { runtimes: { api: {} } },
  runtimes: {
    api: {
      name: 'api',
      worker: artifact('worker', 'worker'),
      host: artifact('host', 'module'),
      planner: artifact('planner', 'module'),
    },
  },
}

function createController(
  options: {
    mode?: 'development' | 'production'
    config?: Partial<Manifest['config']>
    hooks?: ReturnType<typeof createHostHooks>
    failOnWorkerError?: boolean
  } = {},
) {
  return new HostController({
    hooks: options.hooks ?? createHostHooks(),
    failOnWorkerError: options.failOnWorkerError,
    snapshot: createRuntimeSnapshot({
      mode: options.mode ?? 'development',
      outDir: '.',
      manifest: {
        ...manifest,
        config: { ...manifest.config, ...options.config },
      },
      logger: pino({ enabled: false }),
    }),
  })
}

function readyRuntime(): void {
  const ready = createFuture<void>()
  runtime.ready = ready
  ready.resolve()
}

describe('HostController stop during startup', () => {
  it('settles patch application when a stop aborts it', async () => {
    readyRuntime()
    const entered = createFuture<void>()
    const interrupted = createFuture<void>()
    runtime.patch.mockImplementation(async () => {
      entered.resolve()
      await interrupted.promise
      return { outcome: 'rejected', reason: 'rejected', deliveredFiles: [] }
    })
    runtime.stop.mockImplementation(async () => interrupted.resolve())
    const controller = createController()
    await controller.start()
    const applying = controller.applyPatch('api', [])
    applying.catch(() => {})
    await entered.promise
    const stopping = controller.stop()
    try {
      // Stopping the runtime is what settles its patch, so stop cannot wait
      // for the patch first.
      await vi.waitFor(() => expect(runtime.stop).toHaveBeenCalled(), {
        timeout: 200,
      })
      await expect(applying).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      interrupted.resolve()
      await stopping
    }
  })

  // A stop can land in any microtask between two startup steps, not only while
  // one of them is awaited. Sweep the gap instead of assuming its position.
  it.each(Array.from({ length: 12 }, (_, hops) => hops))(
    'never starts runtimes after a stop requested %i microtasks into the previous step',
    async (hops) => {
      const ready = createFuture<void>()
      void ready.promise.catch(() => {})
      runtime.ready = ready
      const hooks = createHostHooks()
      const controller = createController({ mode: 'production', hooks })
      let stopped: Promise<void> | undefined
      let startsAtStop = 0
      hooks.hook('server:start', () => {
        let hop = Promise.resolve()
        for (let index = 0; index < hops; index++) hop = hop.then(() => {})
        void hop.then(() => {
          startsAtStop = runtime.starts.length
          stopped = controller.stop()
        })
      })

      const starting = controller.start().catch((error: unknown) => error)
      await vi.waitFor(() => expect(stopped).toBeDefined())
      const settled = await Promise.race([
        stopped!.then(() => true),
        new Promise<false>((resolve) => setTimeout(resolve, 200, false)),
      ])
      // Release a wrongly started runtime so a failure reports instead of hanging.
      ready.resolve()

      expect(settled).toBe(true)
      expect(await starting).toMatchObject({ name: 'AbortError' })
      // A runtime that began before the stop is interrupted through its owner;
      // none may be created once the stop has been requested.
      expect(runtime.starts.length).toBe(startsAtStop)
    },
  )

  it('joins a subsystem that is still starting before cleaning it up', async () => {
    readyRuntime()
    const events: string[] = []
    const listening = createFuture<void>()
    const release = createFuture<void>()
    proxy.start.mockImplementation(async () => {
      events.push('server:start')
      listening.resolve()
      await release.promise
      events.push('server:started')
    })
    proxy.stop.mockImplementation(async () => {
      events.push('server:stop')
    })
    const controller = createController()

    const starting = controller.start().catch((error: unknown) => error)
    await listening.promise
    const stopping = controller.stop()
    await Promise.resolve()
    expect(events).toEqual(['server:start'])
    release.resolve()
    await stopping

    expect(await starting).toMatchObject({ name: 'AbortError' })
    expect(events).toEqual(['server:start', 'server:started', 'server:stop'])
    expect(runtime.starts).toEqual([])
  })

  it('disposes plugins that finish initializing after the stop gave up on them', async () => {
    readyRuntime()
    const initializing = createFuture<void>()
    const release = createFuture<void>()
    vi.spyOn(PluginEnvironment.prototype, 'initialize').mockImplementation(
      async () => {
        initializing.resolve()
        await release.promise
      },
    )
    const dispose = vi
      .spyOn(PluginEnvironment.prototype, 'dispose')
      .mockResolvedValue()
    const controller = createController({
      config: { lifecycle: { stopTimeout: 20 } },
    })

    const starting = controller.start().catch((error: unknown) => error)
    await initializing.promise
    await expect(controller.stop()).rejects.toThrow(
      'Neem server operation did not settle before the stop deadline',
    )
    expect(controller.getSnapshot().state).toBe('stopped')
    expect(dispose).not.toHaveBeenCalled()

    release.resolve()

    expect(await starting).toMatchObject({ name: 'AbortError' })
    expect(dispose).toHaveBeenCalledOnce()
    expect(runtime.starts).toEqual([])
    await expect(controller.stop()).resolves.toBeUndefined()
  })
})

describe('HostController server health', () => {
  it('pushes every host and runtime state change to the proxy', async () => {
    readyRuntime()
    proxy.setUpstreams.mockResolvedValue()
    const controller = createController({
      mode: 'production',
      config: { server: { port: 0 } },
    })
    await controller.start()

    expect(proxy.publishHealth).toHaveBeenCalled()
    expect(proxy.getHealthStatus?.()).toEqual({ healthy: true, ready: true })

    // Runtime changes go through an upstream sync, which publishes only once
    // the proxy knows the runtime's current upstreams.
    proxy.setUpstreams.mockClear()
    runtime.state = 'recovering'
    runtime.onStateChange?.()
    expect(proxy.setUpstreams).toHaveBeenCalledOnce()
    expect(proxy.getHealthStatus?.()).toEqual({ healthy: true, ready: false })

    proxy.publishHealth.mockClear()
    runtime.onFailure?.(new Error('worker failed'))
    expect(proxy.publishHealth).toHaveBeenCalledOnce()
    expect(proxy.getHealthStatus?.()).toEqual({ healthy: false, ready: false })

    await controller.stop().catch(() => {})
  })

  // Probes must get an answer for the whole lifetime of the runtimes.
  it('listens before runtimes start and stops after they stop', async () => {
    readyRuntime()
    const events: string[] = []
    proxy.start.mockImplementation(async () => {
      events.push('server:start')
    })
    proxy.stop.mockImplementation(async () => {
      events.push('server:stop')
    })
    proxy.setUpstreams.mockImplementation(async () => {
      events.push(`upstreams:${runtime.state}`)
    })
    runtime.stop.mockImplementation(async () => {
      events.push('runtime:stop')
    })
    const controller = createController()

    await controller.start()
    await controller.stop()

    expect(events).toEqual([
      'server:start',
      'upstreams:ready',
      'runtime:stop',
      'server:stop',
    ])
  })

  it('reports a stopping server as unhealthy while stop hooks run', async () => {
    readyRuntime()
    const hooks = createHostHooks()
    const release = createFuture<void>()
    const stopHook = createFuture<void>()
    hooks.hook('server:stop', async () => {
      stopHook.resolve()
      await release.promise
    })
    const controller = createController({
      hooks,
      config: { server: { port: 0 } },
    })
    await controller.start()
    proxy.publishHealth.mockClear()

    const stopping = controller.stop()
    await stopHook.promise
    expect(proxy.publishHealth).toHaveBeenCalledOnce()
    expect(proxy.getHealthStatus?.()).toEqual({ healthy: false, ready: false })
    release.resolve()
    await stopping
  })
})

describe('HostController shutdown', () => {
  it('runs every disposer when an earlier one fails and reports all errors', async () => {
    readyRuntime()
    const hooks = createHostHooks()
    const disposed = vi.fn(() => {
      throw new Error('plugin dispose failed')
    })
    hooks.hook('dispose', disposed)
    proxy.stop.mockRejectedValue(new Error('server stop failed'))
    runtime.stop.mockRejectedValue(new Error('runtime stop failed'))
    const controller = createController({
      hooks,
      config: { server: { port: 0 } },
    })
    await controller.start()

    const stopping = controller.stop()
    await expect(stopping).rejects.toBeInstanceOf(AggregateError)
    const error = (await stopping.catch((failure: unknown) => failure)) as {
      errors: Error[]
    }

    expect(error.errors.map(({ message }) => message)).toEqual([
      'runtime stop failed',
      'server stop failed',
      'plugin dispose failed',
    ])
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(disposed).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().state).toBe('stopped')
    // The first error wins; a later stop does not repeat it.
    await expect(controller.stop()).resolves.toBeUndefined()
  })

  it('fails a stop hook that outlives the budget and still stops the runtimes', async () => {
    readyRuntime()
    runtime.stop.mockResolvedValue()
    const hooks = createHostHooks()
    hooks.hook('server:stop', () => new Promise<void>(() => {}))
    const controller = createController({
      hooks,
      config: { lifecycle: { stopTimeout: 50 } },
    })
    await controller.start()
    const startedAt = Date.now()

    await expect(controller.stop()).rejects.toThrow(
      'Neem hook [server:stop] did not finish within the stop budget',
    )

    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().state).toBe('stopped')
  })

  it('passes one deadline to every runtime it stops', async () => {
    readyRuntime()
    runtime.stop.mockResolvedValue()
    const controller = createController({
      config: { lifecycle: { stopTimeout: 1_234 } },
    })
    await controller.start()
    const before = Date.now()

    await controller.stop()

    const scope = runtime.stop.mock.calls[0]![0]
    expect(scope.deadline).toBeGreaterThanOrEqual(before + 1_234)
    expect(scope.deadline).toBeLessThanOrEqual(Date.now() + 1_234)
  })
})

describe('HostController failures', () => {
  it('keeps an earlier failure after applying a patch', async () => {
    readyRuntime()
    runtime.patch.mockResolvedValue({
      outcome: 'applied',
      deliveredFiles: [],
    })
    const controller = createController({ failOnWorkerError: true })
    await controller.start()
    const failure = new Error('worker failed')
    runtime.onFailure!(failure)

    await controller.applyPatch('api', [])

    expect(controller.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: failure,
    })
    runtime.stop.mockResolvedValue()
    await controller.stop()
  })

  it('records a failure that arrives while a patch is being applied', async () => {
    readyRuntime()
    const entered = createFuture<void>()
    const release = createFuture<void>()
    runtime.patch.mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { outcome: 'applied', deliveredFiles: [] }
    })
    const controller = createController({ failOnWorkerError: true })
    await controller.start()

    const applying = controller.applyPatch('api', [])
    await entered.promise
    const failure = new Error('worker crashed during patch')
    runtime.state = 'failed'
    runtime.onFailure!(failure)
    release.resolve()
    await applying

    expect(controller.getSnapshot()).toMatchObject({
      state: 'failed',
      lastError: failure,
    })
    expect(controller.getHealth().ready).toBe(false)
    runtime.stop.mockResolvedValue()
    await controller.stop()
  })

  it('reports a runtime that is not ready as not ready', async () => {
    readyRuntime()
    const controller = createController()
    await controller.start()
    expect(controller.getHealth().ready).toBe(true)

    runtime.state = 'recovering'

    expect(controller.getHealth()).toMatchObject({
      state: 'running',
      ready: false,
      runtimes: [{ ready: false, state: 'recovering' }],
    })
    runtime.stop.mockResolvedValue()
    await controller.stop()
  })
})
