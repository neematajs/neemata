import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { createFuture } from '@nmtjs/common'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import type { RecoveryOptions } from '../../src/internal/host/recovery.ts'
import type {
  HostRunner,
  HostRunnerOptions,
} from '../../src/internal/host/runner.ts'
import type { Manifest } from '../../src/internal/manifest/manifest.ts'
import type { NeemRuntimeUpstream } from '../../src/shared/types.ts'
import { OperationScope } from '../../src/internal/host/lifecycle.ts'
import { RuntimeController } from '../../src/internal/host/runtime.ts'
import * as logging from '../../src/internal/logger.ts'
import { createRuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
import { createHostHooks } from '../../src/internal/plugins/hooks.ts'
import { wait } from '../../src/internal/utils.ts'
import { createTempDir } from '../support/temp.ts'

// Keep real worker threads and their startup deadline; control only host planning.
const host = vi.hoisted(() => ({
  options: [] as HostRunnerOptions[],
  start: vi.fn<HostRunner['start']>(),
  plan: vi.fn<HostRunner['plan']>(),
  callStart: vi.fn<HostRunner['callStart']>(),
  callStop: vi.fn<HostRunner['callStop']>(),
  shutdown: vi.fn<HostRunner['shutdown']>(),
}))

vi.mock('../../src/internal/host/runner.ts', () => ({
  HostRunner: class {
    constructor(options: HostRunnerOptions) {
      host.options.push(options)
    }
    start = host.start
    plan = host.plan
    callStart = host.callStart
    callStop = host.callStop
    shutdown = host.shutdown
  },
}))

beforeEach(() => {
  // Restore mocks after resource hooks have finished stopping real workers.
  onTestFinished(() => {
    host.options.length = 0
    vi.restoreAllMocks()
    vi.resetAllMocks()
  })
})

describe('RuntimeController recovery', () => {
  it('recovers all planned workers after the first replacement startup times out', async () => {
    const { runtime, onRecovered, onFailure, warn } = await createFixture()
    await runtime.start()
    host.plan
      .mockResolvedValueOnce({ workers: [{ behavior: 'hang' }, {}] })
      .mockResolvedValueOnce({ workers: [{}, {}] })

    runtime.listThreads()[0]!.port.postMessage('crash')
    await vi.waitFor(() => expect(onRecovered).toHaveBeenCalledOnce(), {
      timeout: 40_000,
    })

    expect(host.plan).toHaveBeenCalledTimes(3)
    expect(runtime.getHealth().pool).toMatchObject({
      state: 'ready',
      size: 2,
      ready: 2,
    })
    expect(onFailure).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      {
        err: expect.objectContaining({
          message: expect.stringContaining('30000ms'),
        }),
      },
      'Restarting Neem runtime after failure (2/3)',
    )
  }, 45_000)

  it('runs every production retry and reports exhaustion once after failed startups', async () => {
    const { runtime, onRecovered, onFailure, warn, error } =
      await createFixture()
    await runtime.start()
    host.plan.mockResolvedValue({ workers: [{ behavior: 'fail' }, {}] })

    runtime.listThreads()[0]!.port.postMessage('crash')
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce(), {
      timeout: 4_000,
    })

    expect(host.plan).toHaveBeenCalledTimes(4)
    expect(onRecovered).not.toHaveBeenCalled()
    expect(runtime.listThreads()).toHaveLength(0)
    for (const attempt of [1, 2, 3]) {
      expect(warn).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        `Restarting Neem runtime after failure (${attempt}/3)`,
      )
    }
    const failure = onFailure.mock.calls[0]![0]
    expect(failure.message).toContain('replacement startup failed')
    expect(error).toHaveBeenCalledWith(
      { err: failure },
      'Neem runtime recovery exhausted',
    )
  })

  it('does not restart after an explicit stop during recovery cleanup', async () => {
    const { runtime, onRecovered, onFailure } = await createFixture()
    await runtime.start()
    const entered = createFuture<void>()
    const release = createFuture<void>()
    host.callStop.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })

    const recovery = host.options[0]!.onFailure?.(new Error('host failed'))
    await entered.promise
    const stop = runtime.stop()
    release.resolve()
    await Promise.all([stop, recovery])

    expect(host.start).toHaveBeenCalledTimes(1)
    expect(runtime.listThreads()).toHaveLength(0)
    expect(onRecovered).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('fails the initial start instead of recovering when its generation reports a failure', async () => {
    const { runtime, onRecovered, onFailure } = await createFixture()
    const failure = new Error('host crashed during initial startup')
    host.callStart.mockImplementationOnce(async () => {
      void host.options[0]!.onFailure?.(failure)
      await new Promise(() => {})
    })

    await expect(runtime.start()).rejects.toBe(failure)

    expect(runtime.getState()).toBe('failed')
    expect(host.start).toHaveBeenCalledOnce()
    expect(host.callStop).toHaveBeenCalledOnce()
    expect(runtime.listThreads()).toHaveLength(0)
    expect(onRecovered).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('waits for the crashed generation to release its resources before starting a replacement', async () => {
    const { runtime, onRecovered, onFailure } = await createFixture()
    await runtime.start()
    const entered = createFuture<void>()
    const release = createFuture<void>()
    host.callStop.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })

    const recovery = host.options[0]!.onFailure?.(new Error('host crashed'))
    await entered.promise
    try {
      // The recovery delay is zero; the crashed workers must retain ownership
      // of their resources until their blocked cleanup can finish.
      await wait(25)
      expect(host.start).toHaveBeenCalledTimes(1)
      expect(onRecovered).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await recovery
    }

    expect(host.start).toHaveBeenCalledTimes(2)
    expect(onRecovered).toHaveBeenCalledOnce()
    expect(onFailure).not.toHaveBeenCalled()
    expect(runtime.getHealth()).toMatchObject({
      ready: true,
      state: 'ready',
      pool: { state: 'ready', ready: 2 },
    })
  })

  it('is not ready while it recovers', async () => {
    const { runtime, onRecovered } = await createFixture({
      recovery: { delayMs: 300 },
    })
    await runtime.start()
    expect(runtime.getHealth()).toMatchObject({ ready: true, state: 'ready' })

    runtime.listThreads()[0]!.port.postMessage('crash')
    await vi.waitFor(() => expect(runtime.getState()).toBe('recovering'), {
      timeout: 5_000,
    })

    expect(runtime.getHealth()).toMatchObject({
      ready: false,
      state: 'recovering',
    })
    await vi.waitFor(() => expect(onRecovered).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    })
    expect(runtime.getHealth()).toMatchObject({ ready: true, state: 'ready' })
  })

  it.each([
    'runtime:start',
    'host:start',
    'planning',
    'worker:start',
    'worker:ready',
    'host:callStart',
    'runtime:ready',
  ] as const)('honors an explicit stop during recovery %s', async (stage) => {
    const { runtime, hooks, onRecovered, onFailure } = await createFixture()
    await runtime.start()
    const entered = createFuture<void>()
    const release = createFuture<void>()
    const pause = async () => {
      entered.resolve()
      await release.promise
    }
    const workerStart = vi.fn()
    hooks.hook('worker:start', workerStart)
    const ready = vi.fn()
    hooks.hook('runtime:ready', ready)

    switch (stage) {
      case 'host:start':
        host.start.mockImplementationOnce(pause)
        break
      case 'planning':
        host.plan.mockImplementationOnce(async () => {
          await pause()
          return { workers: [{}, {}] }
        })
        break
      case 'host:callStart':
        host.callStart.mockImplementationOnce(pause)
        break
      default:
        hooks.hook(stage, pause)
    }

    const recovery = host.options[0]!.onFailure?.(new Error('host failed'))
    await entered.promise
    const threads = runtime.listThreads()
    try {
      await runtime.stop()
    } finally {
      release.resolve()
      await recovery
    }

    try {
      expect(threads.every((thread) => thread.getState() === 'stopped')).toBe(
        true,
      )
    } finally {
      await Promise.all(threads.map((thread) => thread.stop()))
    }
    expect(runtime.listThreads()).toHaveLength(0)
    expect(onRecovered).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
    if (stage !== 'runtime:ready') expect(ready).not.toHaveBeenCalled()
    if (stage === 'runtime:start') expect(host.start).toHaveBeenCalledTimes(1)
    if (stage === 'host:start') expect(host.plan).toHaveBeenCalledTimes(1)
    if (['runtime:start', 'host:start', 'planning'].includes(stage)) {
      expect(workerStart).not.toHaveBeenCalled()
    }
  })

  it('does not report exhaustion when stopped during the last failed startup', async () => {
    const { runtime, hooks, onRecovered, onFailure, error } =
      await createFixture()
    await runtime.start()
    host.plan.mockRejectedValue(new Error('planning failed'))
    const entered = createFuture<void>()
    const release = createFuture<void>()
    hooks.hook('runtime:fail', async () => {
      if (host.plan.mock.calls.length !== 4) return
      entered.resolve()
      await release.promise
    })
    const recovery = host.options[0]!.onFailure?.(new Error('host failed'))
    await entered.promise
    try {
      await runtime.stop()
    } finally {
      release.resolve()
      await recovery
    }

    expect(host.plan).toHaveBeenCalledTimes(4)
    expect(onRecovered).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalledWith(
      expect.anything(),
      'Neem runtime recovery exhausted',
    )
  })
})

describe('RuntimeController stop', () => {
  it('joins the start it interrupts before releasing the generation', async () => {
    const { runtime } = await createFixture()
    const entered = createFuture<void>()
    const release = createFuture<void>()
    host.callStart.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })
    let callStopsWhenStartSettled: number | undefined
    const start = runtime.start().catch((error: unknown) => {
      callStopsWhenStartSettled = host.callStop.mock.calls.length
      return error
    })
    await entered.promise
    const threads = runtime.listThreads()

    try {
      await runtime.stop()
    } finally {
      release.resolve()
    }

    expect(await start).toMatchObject({ name: 'AbortError' })
    expect(callStopsWhenStartSettled).toBe(0)
    expect(host.callStop).toHaveBeenCalledOnce()
    expect(threads.map((thread) => thread.getState())).toEqual([
      'stopped',
      'stopped',
    ])
    expect(runtime.getState()).toBe('stopped')
  })

  it('shares one deadline down the stack and fails when a worker has to be terminated', async () => {
    const { runtime } = await createFixture()
    host.plan.mockResolvedValue({ workers: [{ behavior: 'ignore-stop' }, {}] })
    await runtime.start()
    const budgets: Record<string, number> = {}
    host.callStop.mockImplementationOnce(async (scope) => {
      budgets.callStop = scope.remaining()
      await wait(100)
    })
    host.shutdown.mockImplementationOnce(async (scope) => {
      budgets.shutdown = scope.remaining()
    })
    const threadBudgets: number[] = []
    for (const thread of runtime.listThreads()) {
      const stop = thread.stop.bind(thread)
      thread.stop = (scope) => {
        threadBudgets.push(scope!.remaining())
        return stop(scope)
      }
    }
    const startedAt = Date.now()

    const stopping = runtime.stop(OperationScope.withTimeout(500))

    await expect(stopping).rejects.toThrow(
      /Worker \[api:0\] did not stop within \d+ms and was terminated/,
    )
    const elapsed = Date.now() - startedAt
    // Every layer gets what is left of the one budget, never its own constant.
    expect(budgets.callStop).toBeLessThanOrEqual(500)
    expect(threadBudgets).toHaveLength(2)
    for (const remaining of threadBudgets) {
      expect(remaining).toBeLessThanOrEqual(budgets.callStop! - 90)
    }
    expect(budgets.shutdown).toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(450)
    expect(elapsed).toBeLessThan(2_000)
    expect(runtime.getState()).toBe('stopped')
  })
})

describe('RuntimeController upstreams', () => {
  const first = { type: 'http', url: 'http://127.0.0.1:4101/' } as const
  const second = { type: 'http', url: 'http://127.0.0.1:4102/' } as const

  it('detaches a crashed worker before recovery and reattaches after it', async () => {
    const { runtime, onRecovered, onUpstreamsChange, advertised } =
      await createFixture()
    host.plan.mockResolvedValue({
      workers: [{ upstreams: [first] }, { upstreams: [second] }],
    })
    await runtime.start()
    expect(runtime.getUpstreams()).toEqual([first, second])

    runtime.listThreads()[0]!.port.postMessage('crash')
    await vi.waitFor(() => expect(onRecovered).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    })

    // The crashed worker is dropped immediately, the rest once cleanup stops them.
    expect(onUpstreamsChange).toHaveBeenCalledTimes(2)
    expect(advertised).toEqual([[second], []])
    expect(runtime.getUpstreams()).toEqual([first, second])
  })

  it('detaches a crashed worker when recovery is disabled', async () => {
    const { runtime, onFailure, advertised } = await createFixture({
      recovery: { attempts: 0 },
    })
    host.plan.mockResolvedValue({
      workers: [{ upstreams: [first] }, { upstreams: [second] }],
    })
    await runtime.start()

    runtime.listThreads()[0]!.port.postMessage('crash')
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    })

    expect(advertised).toEqual([[second]])
    expect(runtime.getUpstreams()).toEqual([second])
  })
})

describe('RuntimeController patches', () => {
  it('rejects an update that a running thread was not registered for', async () => {
    const { runtime } = await createFixture()
    await runtime.start()
    const [registered, missed] = runtime.listThreads()

    const result = await runtime.applyPatch([
      { clientId: registered!.id, update: { type: 'Noop' } },
    ])

    expect(result).toMatchObject({
      outcome: 'rejected',
      reason: `Worker [${missed!.name}] started without this update`,
    })
  })

  it('an unavailable patch outcome fails the thread and starts recovery', async () => {
    const { runtime, onRecovered, onFailure } = await createFixture()
    await runtime.start()
    const threads = runtime.listThreads()
    const [retired, intact] = threads
    const update = { type: 'Noop' } as const
    retired!.applyPatch = async () => ({
      outcome: 'unavailable',
      delivered: true,
      patches: 0,
      reason: 'failed to apply patch: Error: setup failed',
    })
    intact!.applyPatch = async () => ({
      outcome: 'applied',
      delivered: true,
      patches: 1,
    })

    const result = await runtime.applyPatch(
      threads.map((thread) => ({ clientId: thread.id, update })),
    )

    expect(result).toEqual({
      outcome: 'unavailable',
      reason: 'failed to apply patch: Error: setup failed',
      deliveredFiles: [],
    })
    expect(retired!.getHealth()).toMatchObject({
      state: expect.stringMatching(/failed|stopping|stopped/),
      failureCount: 1,
      lastError: {
        message: expect.stringContaining(
          'has no running generation after a failed patch',
        ),
      },
    })
    await vi.waitFor(() => expect(onRecovered).toHaveBeenCalledOnce(), {
      timeout: 10_000,
    })
    expect(onFailure).not.toHaveBeenCalled()
    expect(host.start).toHaveBeenCalledTimes(2)
    expect(runtime.getHealth()).toMatchObject({
      ready: true,
      state: 'ready',
      pool: { state: 'ready', ready: 2 },
    })
    expect(runtime.listThreads()).not.toContain(retired)
  })

  it('rejects patches while the runtime is not ready', async () => {
    const { runtime } = await createFixture()

    await expect(runtime.applyPatch([])).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'Runtime [api] is not ready',
    })
  })
})

async function createFixture(options: { recovery?: RecoveryOptions } = {}) {
  const outDir = await createTempDir('neem-runtime-controller-')
  const workerEntry = new URL(
    '../../src/internal/worker/entry.ts',
    import.meta.url,
  ).href
  await writeFile(
    resolve(outDir, 'worker-entry.mjs'),
    `import ${JSON.stringify(workerEntry)}`,
  )
  await writeFile(
    resolve(outDir, 'worker.mjs'),
    `
    export default {
      [Symbol.for('neem:runtime-worker')]: true,
      definition: {},
      createRuntime({ data, port }) {
        port.on('message', () => { throw new Error('running worker failed') })
        return {
          async start() {
            if (data.behavior === 'hang') await new Promise(() => {})
            if (data.behavior === 'fail') throw new Error('replacement startup failed')
            return data.upstreams ?? []
          },
          async stop() {
            if (data.behavior === 'ignore-stop') await new Promise(() => {})
          },
        }
      },
    }
  `,
  )
  const owner = { type: 'runtime' as const, name: 'api' }
  const manifest: Manifest = {
    schemaVersion: 3,
    runtime: {
      entry: 'start.js',
      start: {
        id: 'start',
        kind: 'module',
        owner,
        file: 'start.js',
        outDir: '.',
      },
      worker: {
        id: 'worker-entry',
        kind: 'worker',
        owner,
        file: 'worker-entry.mjs',
        outDir: '.',
      },
      runner: {
        id: 'host-runner-entry',
        kind: 'worker',
        owner,
        file: 'runner-entry.mjs',
        outDir: '.',
      },
    },
    config: { runtimes: { api: {} } },
    runtimes: {
      api: {
        name: 'api',
        worker: {
          id: 'worker',
          kind: 'worker',
          owner,
          file: 'worker.mjs',
          outDir: '.',
        },
        host: {
          id: 'host',
          kind: 'module',
          owner,
          file: 'host.mjs',
          outDir: '.',
        },
        planner: {
          id: 'planner',
          kind: 'module',
          owner,
          file: 'planner.mjs',
          outDir: '.',
        },
      },
    },
  }
  const snapshot = createRuntimeSnapshot({
    mode: 'production',
    outDir,
    manifest,
  })
  // Child loggers share these spies so cleanup cannot hide lost diagnostics.
  vi.spyOn(logging, 'childLogger').mockImplementation((logger) => logger)
  const warn = vi.spyOn(snapshot.logger, 'warn')
  const error = vi.spyOn(snapshot.logger, 'error')
  const hooks = createHostHooks()
  const onRecovered = vi.fn()
  const advertised: Array<readonly NeemRuntimeUpstream[]> = []
  const onUpstreamsChange = vi.fn((runtime: RuntimeController) => {
    advertised.push(runtime.getUpstreams())
  })
  const onFailure = vi.fn<(error: Error, runtime: RuntimeController) => void>()
  host.start.mockResolvedValue()
  host.plan.mockResolvedValue({ workers: [{}, {}] })
  host.callStart.mockResolvedValue()
  host.callStop.mockResolvedValue()
  host.shutdown.mockResolvedValue()
  const runtime = new RuntimeController({
    snapshot,
    runtimeName: 'api',
    hooks,
    recovery: { delayMs: 0, ...options.recovery },
    onRecovered,
    onUpstreamsChange,
    onFailure,
  })
  onTestFinished(() => runtime.stop())
  return {
    runtime,
    hooks,
    onRecovered,
    onUpstreamsChange,
    advertised,
    onFailure,
    warn,
    error,
  }
}
