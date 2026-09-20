import { MessageChannel } from 'node:worker_threads'

import type { NeemRuntime } from '@nmtjs/neem'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { pino } from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EffectApplication } from '../../src/neem/worker.ts'
import { createEffectRuntime } from '../../src/index.ts'
import { defineEffectWorker } from '../../src/neem/worker.ts'

class Resource extends Context.Service<Resource, string>()('Resource') {}

const runtimes: NeemRuntime[] = []
const channels: MessageChannel[] = []

async function create<R, EL, EM>(application: EffectApplication<R, EL, EM>) {
  const channel = new MessageChannel()
  channels.push(channel)
  const runtime = await defineEffectWorker(() => application).createRuntime({
    data: {},
    definition: undefined,
    mode: 'production',
    name: 'api:0',
    logger: pino({ enabled: false }),
    port: channel.port1,
  })
  runtimes.push(runtime)
  return runtime
}

afterEach(async () => {
  await Promise.allSettled(
    runtimes.splice(0).map(async (runtime) => runtime.stop()),
  )
  for (const { port1, port2 } of channels.splice(0)) {
    port1.close()
    port2.close()
  }
})

describe('Effect worker lifetime', () => {
  it('keeps runtime declarations pure and allows a custom planner', () => {
    expect(createEffectRuntime({ name: 'api' }).planner).toBe(
      '@nmtjs/effect/neem/planner',
    )
    expect(createEffectRuntime({ planner: './plan.ts' }).planner).toBe(
      './plan.ts',
    )
  })

  it('waits for explicit readiness and finalizes main before its services exactly once', async () => {
    const events: string[] = []
    const gate = Promise.withResolvers<void>()
    const layer = Layer.effect(Resource)(
      Effect.acquireRelease(
        Effect.sync(() => {
          events.push('acquire')
          return 'service'
        }),
        () => Effect.sync(() => events.push('release-service')),
      ),
    )
    const runtime = await create({
      layer,
      main: (ready) =>
        Effect.gen(function* () {
          events.push(yield* Resource)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => events.push('release-main')),
          )
          yield* Effect.promise(() => gate.promise)
          yield* ready([{ type: 'http', url: 'http://127.0.0.1:1234' }])
          yield* Effect.never
        }),
    })
    expect(events).toEqual([])
    const start = runtime.start()
    expect(runtime.start()).toBe(start)
    const started = vi.fn()
    void Promise.resolve(start).then(started)
    await vi.waitFor(() => expect(events).toEqual(['acquire', 'service']))
    expect(started).not.toHaveBeenCalled()
    gate.resolve()
    await expect(start).resolves.toEqual([
      { type: 'http', url: 'http://127.0.0.1:1234' },
    ])

    const stop = runtime.stop()
    expect(runtime.stop()).toBe(stop)
    await stop
    await expect(runtime.finished).resolves.toBeUndefined()
    expect(events).toEqual([
      'acquire',
      'service',
      'release-main',
      'release-service',
    ])
    await expect(runtime.start()).rejects.toThrow('stopped')
  })

  it('releases partially acquired services when layer construction fails', async () => {
    const release = vi.fn()
    const main = vi.fn(() => Effect.never)
    const error = { _tag: 'Unavailable' }
    const runtime = await create({
      layer: Layer.effect(Resource)(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(Effect.void, () => Effect.sync(release))
          return yield* Effect.fail(error)
        }),
      ),
      main,
    })
    await expect(runtime.start()).rejects.toBe(error)
    await expect(runtime.finished).rejects.toBe(error)
    await runtime.stop()
    expect(main).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it.each(['fail', 'die', 'throw'] as const)(
    'reports a startup %s and releases its layer',
    async (kind) => {
      const error = new Error(`startup-${kind}`)
      const release = vi.fn()
      const runtime = await create({
        layer: Layer.effect(Resource)(
          Effect.acquireRelease(Effect.succeed('value'), () =>
            Effect.sync(release),
          ),
        ),
        main() {
          if (kind === 'throw') throw error
          return kind === 'fail' ? Effect.fail(error) : Effect.die(error)
        },
      })
      await expect(runtime.start()).rejects.toBe(error)
      await expect(runtime.finished).rejects.toBe(error)
      expect(release).toHaveBeenCalledOnce()
    },
  )

  it('reports a failure after readiness only after resources are released', async () => {
    const gate = Promise.withResolvers<void>()
    const error = new Error('main failed')
    const release = vi.fn()
    const runtime = await create({
      layer: Layer.effect(Resource)(
        Effect.acquireRelease(Effect.succeed('value'), () =>
          Effect.sync(release),
        ),
      ),
      main: (ready) =>
        Effect.gen(function* () {
          yield* ready()
          yield* Effect.promise(() => gate.promise)
          return yield* Effect.fail(error)
        }),
    })
    await runtime.start()
    gate.resolve()
    await expect(runtime.finished).rejects.toBe(error)
    expect(release).toHaveBeenCalledOnce()
    await expect(runtime.stop()).resolves.toBeUndefined()
  })

  it.each([false, true])(
    'rejects early successful completion (ready=%s)',
    async (signal) => {
      const runtime = await create({
        layer: Layer.empty,
        main: (ready) => (signal ? ready() : Effect.void),
      })
      await expect(runtime.start()).rejects.toThrow('completed before stop')
      await expect(runtime.finished).rejects.toThrow('completed before stop')
    },
  )

  it('treats user-code interruption as failure when stop was not requested', async () => {
    const gate = Promise.withResolvers<void>()
    const runtime = await create({
      layer: Layer.empty,
      main: (ready) =>
        Effect.gen(function* () {
          yield* ready()
          yield* Effect.promise(() => gate.promise)
          yield* Effect.interrupt
        }),
    })
    await runtime.start()
    gate.resolve()
    await expect(runtime.finished).rejects.toBeDefined()
  })

  // This is the preset contract; Neem does not currently dispatch stop during startup.
  it('interrupts startup and releases resources when runtime.stop is called directly', async () => {
    const release = vi.fn()
    const acquired = Promise.withResolvers<void>()
    const runtime = await create({
      layer: Layer.empty,
      main: () =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => acquired.resolve()),
            () => Effect.sync(release),
          )
          yield* Effect.never
        }),
    })
    const start = runtime.start()
    const rejected = expect(start).rejects.toThrow('stopped before readiness')
    await acquired.promise
    await runtime.stop()
    await rejected
    expect(release).toHaveBeenCalledOnce()
  })

  it('can stop before start without acquiring services', async () => {
    const main = vi.fn(() => Effect.never)
    const runtime = await create({ layer: Layer.empty, main })
    await runtime.stop()
    await expect(runtime.finished).resolves.toBeUndefined()
    await expect(runtime.start()).rejects.toThrow('stopped')
    expect(main).not.toHaveBeenCalled()
  })

  it('does not hide finalizer defects during requested shutdown', async () => {
    const error = new Error('cleanup failed')
    const runtime = await create({
      layer: Layer.empty,
      main: (ready) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.die(error))
          yield* ready()
          yield* Effect.never
        }),
    })
    await runtime.start()
    await expect(runtime.stop()).rejects.toBe(error)
    await expect(runtime.finished).rejects.toBe(error)
  })
})
