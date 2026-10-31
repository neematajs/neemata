import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { Host } from '../../../src/host.ts'
import { createHostHooks } from '../../../src/internal/hooks.ts'
import { Deadline } from '../../../src/internal/lifetime.ts'
import { ProxyController } from '../../../src/internal/proxy.ts'
import { createSupervisor, listenToWorkers } from './support/runtime.ts'

const native = vi.hoisted(() => ({
  attempts: 0,
  fail: 0,
  stopped: 0,
  failRemove: false,
  registered: new Set<number>(),
  // Every readiness the host published, in order.
  published: [] as boolean[],
}))
vi.mock('@nmtjs/proxy', () => ({
  Proxy: class {
    async start() {}
    async stop() {
      native.stopped++
      native.registered.clear()
    }
    address() {
      throw new Error('address inspection unavailable')
    }
    async addUpstream(_name: string, upstream: { port: number }) {
      native.attempts++
      if (native.attempts <= native.fail)
        throw new Error('temporary add failure')
      if (native.registered.has(upstream.port)) throw new Error('duplicate add')
      native.registered.add(upstream.port)
    }
    async removeUpstream(_name: string, upstream: { port: number }) {
      if (native.failRemove) throw new Error('temporary removal failure')
      if (!native.registered.delete(upstream.port))
        throw new Error('missing upstream')
    }
    setHealth(status: { ready: boolean }) {
      native.published.push(status.ready)
    }
  },
}))

beforeEach(() => {
  native.attempts = 0
  native.fail = 0
  native.stopped = 0
  native.failRemove = false
  native.registered.clear()
  native.published = []
})
const desired = [
  {
    runtimeName: 'app',
    upstreams: [{ type: 'http' as const, url: 'http://127.0.0.1:4101' }],
  },
]
const test = (body: (proxy: ProxyController) => Effect.Effect<void, Error>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { snapshot } = createSupervisor({ plan: [] })
      snapshot.config.runtimes.app = { proxy: {} }
      const proxy = new ProxyController(snapshot)
      yield* proxy.start([])
      yield* body(proxy).pipe(
        Effect.ensuring(
          Deadline.make(1000).pipe(
            Effect.flatMap((d) => proxy.stop(d)),
            Effect.orDie,
          ),
        ),
      )
    }).pipe(Effect.provide(TestClock.layer())),
  )

describe('Effect proxy reconciliation', () => {
  it('retries transient mutations and restores readiness using the provided clock', () =>
    test((proxy) =>
      Effect.gen(function* () {
        native.fail = 1
        expect((yield* Effect.exit(proxy.setUpstreams(desired)))._tag).toBe(
          'Failure',
        )
        expect(proxy.getHealth().ready).toBe(false)
        yield* TestClock.adjust(99)
        expect(native.attempts).toBe(1)
        yield* TestClock.adjust(1)
        expect(native.attempts).toBe(2)
        expect(proxy.getHealth()).toMatchObject({
          ready: true,
          failedUpstreams: [],
          pending: 0,
        })
        yield* TestClock.adjust(10_000)
        expect(native.attempts).toBe(2)
      }),
    ))
  it('cancels a retry when its upstream is no longer wanted', () =>
    test((proxy) =>
      Effect.gen(function* () {
        native.fail = Infinity
        yield* Effect.exit(proxy.setUpstreams(desired))
        yield* proxy.setUpstreams([])
        yield* TestClock.adjust(10_000)
        expect(native.attempts).toBe(1)
        expect(proxy.getHealth()).toMatchObject({
          ready: true,
          failedUpstreams: [],
          upstreams: [],
        })
      }),
    ))
  it('stops retries and rejects further mutations after shutdown', async () => {
    await test((proxy) =>
      Effect.gen(function* () {
        native.fail = Infinity
        yield* Effect.exit(proxy.setUpstreams(desired))
        yield* proxy.stop(yield* Deadline.make(1000))
        yield* TestClock.adjust(10_000)
        yield* proxy.setUpstreams(desired)
        expect(native.attempts).toBe(1)
        expect(native.stopped).toBe(1)
        expect(proxy.getHealth().running).toBe(false)
      }),
    )
    expect(native.stopped).toBe(1)
  })
})

it('clears an obsolete removal failure when the applied upstream is wanted again', () =>
  test((proxy) =>
    Effect.gen(function* () {
      yield* proxy.setUpstreams(desired)
      native.failRemove = true
      expect((yield* Effect.exit(proxy.setUpstreams([])))._tag).toBe('Failure')
      expect(proxy.getHealth().ready).toBe(false)
      yield* proxy.setUpstreams(desired)
      expect(proxy.getHealth()).toMatchObject({
        ready: true,
        failedUpstreams: [],
      })
      yield* TestClock.adjust(10_000)
      expect(native.attempts).toBe(1)
    }),
  ))

it('does not execute an interrupted host operation after it leaves the queue', async () => {
  const { snapshot } = createSupervisor({ plan: [] })
  snapshot.manifest.runtimes = {}
  const hooks = createHostHooks()
  const entered = Deferred.makeUnsafe<void>(),
    release = Deferred.makeUnsafe<void>()
  let starts = 0
  hooks.hook('server:start', () =>
    Effect.gen(function* () {
      starts++
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    }),
  )
  const host = new Host({ snapshot, hooks })
  const starting = Effect.runFork(host.start())
  await Effect.runPromise(Deferred.await(entered))
  const queued = Effect.runFork(host.reload(snapshot))
  await Effect.runPromise(Fiber.interrupt(queued))
  Deferred.doneUnsafe(release, Effect.void)
  try {
    await Effect.runPromise(Fiber.join(starting))
    expect(starts).toBe(1)
  } finally {
    await Effect.runPromise(host.stop(Deadline.after(1000)))
  }
})

it('keeps a stopping host unready when the stop interrupts a patch in flight', async () => {
  const workers = listenToWorkers()
  const { snapshot } = createSupervisor({
    plan: [{ id: 'held', holdPatch: true }],
  })
  const host = new Host({ snapshot, hooks: createHostHooks() })
  try {
    await Effect.runPromise(host.start())
    expect(native.published.at(-1)).toBe(true)
    const [thread] = host.getHealth().runtimes[0]!.threads
    const patching = Effect.runFork(
      host.applyPatch('app', [
        {
          clientId: thread!.id,
          update: {
            type: 'Patch',
            filename: 'patch.js',
            seq: 1,
            changedIds: [],
          },
        },
      ]),
    )
    await workers.waitFor('held:patch')
    expect(native.published.at(-1)).toBe(false)
    const since = native.published.length

    const stopping = Effect.runFork(host.stop(Deadline.after(5_000)))
    // The host abandons the patch at once; the worker still holds it, as a
    // worker holds a generation replacement it cannot interrupt. The release
    // comes later, so a stale publish has time to happen meanwhile.
    await Effect.runPromise(Fiber.await(patching))
    await new Promise((resolve) => setTimeout(resolve, 50))
    workers.release('held')
    await Effect.runPromise(Fiber.join(stopping))
    expect(native.published.slice(since)).not.toContain(true)
  } finally {
    workers.close()
    await Effect.runPromise(host.stop(Deadline.after(1000)))
  }
})
