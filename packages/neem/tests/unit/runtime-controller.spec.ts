import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createFuture } from '@nmtjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  HostRunner,
  HostRunnerOptions,
} from '../../src/internal/host/runner.ts'
import type { Manifest } from '../../src/internal/manifest/manifest.ts'
import { RuntimeController } from '../../src/internal/host/runtime.ts'
import * as logging from '../../src/internal/logger.ts'
import { createRuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
import { createHostHooks } from '../../src/internal/plugins/hooks.ts'
import { wait } from '../../src/internal/utils.ts'

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

const runtimes: RuntimeController[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()))
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
  host.options.length = 0
  vi.restoreAllMocks()
  vi.resetAllMocks()
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

  it('waits for failed initial startup cleanup before starting replacements', async () => {
    const { runtime, onRecovered, onFailure } = await createFixture()
    const entered = createFuture<void>()
    const release = createFuture<void>()
    const failure = new Error('host crashed during initial startup')
    let recovery: Promise<void> | undefined
    host.callStart.mockImplementationOnce(async () => {
      recovery = Promise.resolve(host.options[0]!.onFailure?.(failure))
      throw failure
    })
    host.callStop.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
    })

    const startup = expect(runtime.start()).rejects.toThrow(failure)
    await entered.promise
    try {
      // The recovery delay is zero; the original workers must retain ownership
      // of their resources until their blocked cleanup can finish.
      await wait(25)
      expect(host.start).toHaveBeenCalledTimes(1)
      expect(onRecovered).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await startup
      await recovery
    }

    expect(host.start).toHaveBeenCalledTimes(2)
    expect(host.callStop).toHaveBeenCalledTimes(1)
    expect(onRecovered).toHaveBeenCalledOnce()
    expect(onFailure).not.toHaveBeenCalled()
    expect(runtime.getHealth().pool).toMatchObject({ state: 'ready', ready: 2 })
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

async function createFixture() {
  const outDir = await mkdtemp(resolve(tmpdir(), 'neem-runtime-controller-'))
  tempDirs.push(outDir)
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
            return []
          },
          async stop() {},
        }
      },
    }
  `,
  )
  const owner = { type: 'runtime' as const, name: 'api' }
  const manifest: Manifest = {
    schemaVersion: 1,
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
    recovery: { delayMs: 0 },
    onRecovered,
    onFailure,
  })
  runtimes.push(runtime)
  return { runtime, hooks, onRecovered, onFailure, warn, error }
}
