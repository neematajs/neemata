import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { createFuture } from '@nmtjs/common'
import { afterEach, describe, expect, it } from 'vitest'

import type { Manifest } from '../../src/internal/manifest/manifest.ts'
import { ThreadController } from '../../src/internal/host/thread.ts'
import { createRuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
import { createHostHooks } from '../../src/internal/plugins/hooks.ts'
import { raceWithTimeout } from '../../src/internal/utils.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('ThreadController', () => {
  it('stops when the worker exits after stop cleanup despite live handles', async () => {
    const fixture = await createThreadFixture(`
      import { parentPort } from 'node:worker_threads'

      setInterval(() => {}, 1_000)
      parentPort.postMessage({ type: 'ready', data: { upstreams: [] } })
      parentPort.on('message', (message) => {
        if (message.type === 'stop') {
          parentPort.postMessage({ type: 'stopped' })
          parentPort.close()
          setImmediate(() => process.exit(0))
        }
      })
    `)
    const thread = new ThreadController({
      snapshot: fixture.snapshot,
      runtimeName: 'api',
      plan: { name: 'api:0', artifact: fixture.artifact },
      index: 0,
      hooks: createHostHooks(),
    })

    await thread.start()

    const stop = thread.stop()
    const result = await raceWithTimeout(stop, 300)
    try {
      expect(result.timedOut).toBe(false)
    } finally {
      if (result.timedOut) {
        await (
          thread as unknown as { terminateWorker: () => Promise<void> }
        ).terminateWorker()
      }
      await stop.catch(() => undefined)
    }
  })

  it('runs failure handling when the worker exits while the ready hook is pending', async () => {
    const fixture = await createThreadFixture(`
      import { parentPort } from 'node:worker_threads'

      parentPort.postMessage({ type: 'ready', data: { upstreams: [] } })
      setImmediate(() => process.exit(1))
    `)
    const hooks = createHostHooks()
    const readyHookEntered = createFuture<void>()
    const releaseReadyHook = createFuture<void>()
    const failHookObserved = createFuture<Error>()
    const failureObserved = createFuture<Error>()
    let failHookCalls = 0
    let onFailureCalls = 0

    hooks.hook('worker:ready', async () => {
      readyHookEntered.resolve()
      await releaseReadyHook.promise
    })
    hooks.hook('worker:fail', (event) => {
      failHookCalls += 1
      if (event.error) failHookObserved.resolve(event.error)
    })

    const thread = new ThreadController({
      snapshot: fixture.snapshot,
      runtimeName: 'api',
      plan: { name: 'api:0', artifact: fixture.artifact },
      index: 0,
      hooks,
      onFailure: (error) => {
        onFailureCalls += 1
        failureObserved.resolve(error)
      },
    })

    const start = thread.start()
    await readyHookEntered.promise

    const [failHookResult, failureResult] = await Promise.all([
      raceWithTimeout(failHookObserved.promise, 1_000),
      raceWithTimeout(failureObserved.promise, 1_000),
    ])

    try {
      expect(failHookResult.timedOut).toBe(false)
      expect(failureResult.timedOut).toBe(false)
      if (!failHookResult.timedOut) {
        expect(failHookResult.value.message).toContain('exited with code [1]')
      }
      if (!failureResult.timedOut) {
        expect(failureResult.value.message).toContain('exited with code [1]')
      }
      expect(failHookCalls).toBe(1)
      expect(onFailureCalls).toBe(1)
      expect(thread.getState()).toBe('failed')
    } finally {
      releaseReadyHook.resolve()
      await start.catch(() => undefined)
      await thread.stop().catch(() => undefined)
    }

    expect(failHookCalls).toBe(1)
    expect(onFailureCalls).toBe(1)
  })

  it('rejects startup without recovery when the worker exits before ready', async () => {
    const fixture = await createThreadFixture(`
      process.exit(1)
    `)
    const hooks = createHostHooks()
    let failHookCalls = 0
    let onFailureCalls = 0
    hooks.hook('worker:fail', () => {
      failHookCalls += 1
    })

    const thread = new ThreadController({
      snapshot: fixture.snapshot,
      runtimeName: 'api',
      plan: { name: 'api:0', artifact: fixture.artifact },
      index: 0,
      hooks,
      onFailure: () => {
        onFailureCalls += 1
      },
    })

    await expect(thread.start()).rejects.toThrow('exited with code [1]')

    expect(failHookCalls).toBe(1)
    expect(onFailureCalls).toBe(0)
    expect(thread.getState()).toBe('failed')

    await thread.stop().catch(() => undefined)
  })
})

async function createThreadFixture(workerSource: string) {
  const outDir = await mkdtemp(resolve(tmpdir(), 'neem-thread-controller-'))
  tempDirs.push(outDir)

  const workerEntry = resolve(outDir, 'worker-entry.mjs')
  const runtimeWorker = resolve(outDir, 'runtime-worker.mjs')
  await writeFile(workerEntry, workerSource)
  await writeFile(runtimeWorker, 'export default {}\n')

  const artifact = {
    id: 'api-worker',
    kind: 'worker' as const,
    owner: { type: 'runtime' as const, name: 'api' },
    file: runtimeWorker,
    outDir,
  }
  const manifest: Manifest = {
    schemaVersion: 1,
    runtime: {
      entry: 'start.js',
      start: {
        id: 'start',
        kind: 'module',
        owner: { type: 'runtime', name: 'start' },
        file: 'start.js',
        outDir: '.',
      },
      worker: {
        id: 'worker-entry',
        kind: 'worker',
        owner: { type: 'runtime', name: 'worker' },
        file: 'worker-entry.mjs',
        outDir: '.',
      },
    },
    config: { runtimes: { api: {} } },
    runtimes: {
      api: {
        name: 'api',
        worker: {
          id: 'api-worker',
          kind: 'worker',
          owner: { type: 'runtime', name: 'api' },
          file: 'runtime-worker.mjs',
          outDir: '.',
        },
        host: {
          id: 'api-host',
          kind: 'module',
          owner: { type: 'runtime', name: 'api' },
          file: 'host.mjs',
          outDir: '.',
        },
        planner: {
          id: 'api-planner',
          kind: 'module',
          owner: { type: 'runtime', name: 'api' },
          file: 'planner.mjs',
          outDir: '.',
        },
      },
    },
  }

  return {
    artifact,
    snapshot: createRuntimeSnapshot({ mode: 'development', outDir, manifest }),
  }
}
