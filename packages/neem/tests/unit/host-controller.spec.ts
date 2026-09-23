import { createFuture } from '@nmtjs/common'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Manifest } from '../../src/internal/manifest/manifest.ts'
import { HostController } from '../../src/internal/host/controller.ts'
import { createRuntimeSnapshot } from '../../src/internal/manifest/snapshot.ts'
import { createHostHooks } from '../../src/internal/plugins/hooks.ts'

// Control runtime readiness; the controller's hooks and operation queue are real.
const runtime = vi.hoisted(() => ({
  starts: [] as string[],
  patch: vi.fn(),
  stopped: vi.fn(),
  ready: undefined as
    | undefined
    | { promise: Promise<void>; reject(e: Error): void },
}))

vi.mock('../../src/internal/host/runtime.ts', () => ({
  RuntimeController: class {
    async start() {
      runtime.starts.push('start')
      await runtime.ready!.promise
    }
    async stop() {
      runtime.ready!.reject(new Error('stopped before ready'))
      runtime.stopped()
    }
    applyPatch = runtime.patch
    getUpstreams = () => []
    getHealth = () => ({ name: 'api', ready: false, workers: [] })
    setSnapshot() {}
  },
}))

afterEach(() => {
  runtime.starts.length = 0
  runtime.ready = undefined
  runtime.patch.mockReset()
  runtime.stopped.mockReset()
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
  schemaVersion: 1,
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

describe('HostController stop during startup', () => {
  it('interrupts patch application before joining the operation queue', async () => {
    const ready = createFuture<void>()
    runtime.ready = ready
    ready.resolve()
    const entered = createFuture<void>()
    const interrupted = createFuture<void>()
    runtime.patch.mockImplementation(async () => {
      entered.resolve()
      await interrupted.promise
      return { accepted: false, deliveredFiles: [] }
    })
    runtime.stopped.mockImplementation(() => interrupted.resolve())
    const controller = new HostController({
      hooks: createHostHooks(),
      snapshot: createRuntimeSnapshot({
        mode: 'development',
        outDir: '.',
        manifest,
        logger: pino({ enabled: false }),
      }),
    })
    await controller.start()
    const applying = controller.applyPatch('api', [])
    await entered.promise
    const stopping = controller.stop()
    try {
      await vi.waitFor(() => expect(runtime.stopped).toHaveBeenCalled(), {
        timeout: 200,
      })
    } finally {
      interrupted.resolve()
      await Promise.all([applying, stopping])
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
      const controller = new HostController({
        hooks,
        snapshot: createRuntimeSnapshot({
          mode: 'production',
          outDir: '.',
          manifest,
          logger: pino({ enabled: false }),
        }),
      })
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

      const starting = controller.start().catch(() => {})
      await vi.waitFor(() => expect(stopped).toBeDefined())
      const settled = await Promise.race([
        stopped!.then(() => true),
        new Promise<false>((resolve) => setTimeout(resolve, 200, false)),
      ])
      // Release a wrongly started runtime so a failure reports instead of hanging.
      ready.resolve()
      await starting

      expect(settled).toBe(true)
      // A runtime that began before the stop is interrupted through its owner;
      // none may be created once the stop has been requested.
      expect(runtime.starts.length).toBe(startsAtStop)
    },
  )
})
