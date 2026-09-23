import type { Future } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { OperationScope } from '../../src/internal/host/lifecycle.ts'
import type { Manifest } from '../../src/internal/manifest/manifest.ts'
import type { NeemRuntimeState } from '../../src/shared/types.ts'
import { HostController } from '../../src/internal/host/controller.ts'
import { HealthProbe } from '../../src/internal/host/health.ts'
import { createRuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
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
  ready: undefined as undefined | Future<void>,
}))

const proxy = vi.hoisted(() => ({
  stop: vi.fn<() => Promise<void>>(),
}))

vi.mock('../../src/internal/host/runtime.ts', () => ({
  RuntimeController: class {
    name = 'api'
    constructor(options: { onFailure?: (error: Error) => void }) {
      runtime.onFailure = options.onFailure
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
    async start() {}
    stop = proxy.stop
    async setUpstreams() {}
    getHealth = () => ({ enabled: true, ready: true })
  },
}))

afterEach(() => {
  runtime.starts.length = 0
  runtime.ready = undefined
  runtime.onFailure = undefined
  runtime.state = 'idle'
  runtime.lastError = undefined
  runtime.patch.mockReset()
  runtime.stop.mockReset()
  proxy.stop.mockReset()
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
  schemaVersion: 2,
  runtime: {
    entry: 'start.js',
    start: artifact('start', 'module'),
    worker: artifact('worker-entry', 'worker'),
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
      return { accepted: false, deliveredFiles: [] }
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
    vi.spyOn(HealthProbe.prototype, 'start').mockImplementation(async () => {
      events.push('probe:start')
      listening.resolve()
      await release.promise
      events.push('probe:started')
    })
    vi.spyOn(HealthProbe.prototype, 'stop').mockImplementation(async () => {
      events.push('probe:stop')
    })
    const controller = createController({ config: { health: { port: 0 } } })

    const starting = controller.start().catch((error: unknown) => error)
    await listening.promise
    const stopping = controller.stop()
    await Promise.resolve()
    expect(events).toEqual(['probe:start'])
    release.resolve()
    await stopping

    expect(await starting).toMatchObject({ name: 'AbortError' })
    expect(events).toEqual(['probe:start', 'probe:started', 'probe:stop'])
    expect(runtime.starts).toEqual([])
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
    proxy.stop.mockRejectedValue(new Error('proxy stop failed'))
    runtime.stop.mockRejectedValue(new Error('runtime stop failed'))
    const controller = createController({
      hooks,
      config: { proxy: { hostname: '127.0.0.1', port: 0 } },
    })
    await controller.start()

    const stopping = controller.stop()
    await expect(stopping).rejects.toBeInstanceOf(AggregateError)
    const error = (await stopping.catch((failure: unknown) => failure)) as {
      errors: Error[]
    }

    expect(error.errors.map(({ message }) => message)).toEqual([
      'proxy stop failed',
      'runtime stop failed',
      'plugin dispose failed',
    ])
    expect(runtime.stop).toHaveBeenCalledOnce()
    expect(disposed).toHaveBeenCalledOnce()
    expect(controller.getSnapshot().state).toBe('stopped')
    // The first error wins; a later stop does not repeat it.
    await expect(controller.stop()).resolves.toBeUndefined()
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
      accepted: true,
      deliveredFiles: [],
      reset: false,
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
      return { accepted: true, deliveredFiles: [], reset: false }
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
