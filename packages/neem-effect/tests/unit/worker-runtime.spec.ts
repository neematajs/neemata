import type {
  NeemRuntime,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem/internal/shared/types'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { describe, expect, it } from 'vitest'

import { Deadline } from '../../src/internal/lifetime.ts'
import { WorkerRuntime } from '../../src/worker/runtime.ts'

type Gate = { promise: Promise<void>; open: () => void }

function gate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function createHarness(mode: 'development' | 'production' = 'development') {
  const events: string[] = []
  const finished: Error[] = []
  const runtime = new WorkerRuntime({
    mode,
    onFinished: (error) => finished.push(error),
    onStartError: () => {},
    onCleanupError: () => {},
  })
  const worker = (
    name: string,
    options: {
      created?: Promise<void>
      finished?: Promise<void>
      upstreams?: { type: 'http'; url: string }[]
    } = {},
  ): NeemRuntimeWorker =>
    ({
      definition: { name },
      async createRuntime() {
        events.push(`${name}:create`)
        await options.created
        events.push(`${name}:created`)
        const created: NeemRuntime = {
          start: () => {
            events.push(`${name}:start`)
            return options.upstreams ?? []
          },
          stop: () => {
            events.push(`${name}:stop`)
          },
          finished: options.finished,
        }
        return created
      },
    }) as NeemRuntimeWorker
  const boot = (next: NeemRuntimeWorker) =>
    Effect.runSync(
      runtime.boot(
        Effect.succeed({
          worker: next,
          context: { definition: next.definition } as NeemRuntimeWorkerContext,
        }),
      ),
    )
  return { runtime, events, finished, worker, boot }
}

describe('WorkerRuntime', () => {
  it('stops a runtime whose factory resolves only after the stop began', async () => {
    const { runtime, events, worker, boot } = createHarness()
    const created = gate()
    boot(worker('first', { created: created.promise }))
    await Promise.resolve()

    const stopping = Effect.runPromise(runtime.stop(Deadline.after(5_000)))
    setTimeout(created.open, 20)
    expect(await stopping).toEqual([])
    // The stop waited for the late runtime and stopped it, without starting it.
    expect(events).toEqual(['first:create', 'first:created', 'first:stop'])
  })

  it('runs one patch at a time even when the caller stops waiting', async () => {
    const { runtime } = createHarness()
    const first = gate()
    const order: string[] = []
    const patch = (name: string, done?: Promise<void>) =>
      runtime.patch(
        Effect.promise(async () => {
          order.push(`${name}:begin`)
          await done
          order.push(`${name}:end`)
        }),
      )

    const firstFiber = Effect.runFork(patch('first', first.promise))
    await new Promise((resolve) => setTimeout(resolve, 10))
    // The host gave up on the first patch: it still owns the worker's modules.
    const interrupted = Effect.runFork(Fiber.interrupt(firstFiber))
    const second = Effect.runPromise(patch('second'))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['first:begin'])

    first.open()
    await second
    await Effect.runPromise(Fiber.await(interrupted))
    expect(order).toEqual([
      'first:begin',
      'first:end',
      'second:begin',
      'second:end',
    ])
  })

  it('drops a patch that is interrupted while it waits for its turn', async () => {
    const { runtime } = createHarness()
    const first = gate()
    const ran: string[] = []
    const running = Effect.runPromise(
      runtime.patch(Effect.promise(() => first.promise)),
    )
    const waiting = Effect.runFork(
      runtime.patch(Effect.sync(() => ran.push('waiting'))),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await Effect.runPromise(Fiber.interrupt(waiting))
    first.open()
    await running
    expect(ran).toEqual([])
  })

  it('reports only an unexpected end of the generation that is current', async () => {
    const { runtime, finished, worker, boot } = createHarness()
    const firstDone = gate()
    boot(worker('first', { finished: firstDone.promise }))
    await Effect.runPromise(Deferred.await(runtime.ready))

    await Effect.runPromise(runtime.replace(worker('second')))
    // The replaced generation ending is expected and must not fail the worker.
    firstDone.open()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished).toEqual([])

    const third = gate()
    await Effect.runPromise(
      runtime.replace(worker('third', { finished: third.promise })),
    )
    third.open()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(finished.map((error) => error.message)).toEqual([
      'Neem runtime finished before stop was requested',
    ])
  })

  it('stops a replacement that changed its upstreams and leaves none serving', async () => {
    const { runtime, events, worker, boot } = createHarness()
    boot(worker('first', { upstreams: [{ type: 'http', url: 'http://a' }] }))
    await Effect.runPromise(Deferred.await(runtime.ready))

    const error = await Effect.runPromise(
      Effect.flip(
        runtime.replace(
          worker('second', { upstreams: [{ type: 'http', url: 'http://b' }] }),
        ),
      ),
    )
    expect(error.message).toContain('changed runtime upstreams')
    expect(events).toEqual([
      'first:create',
      'first:created',
      'first:start',
      'first:stop',
      'second:create',
      'second:created',
      'second:start',
      'second:stop',
    ])
    expect(
      await Effect.runPromise(runtime.stop(Deadline.after(1_000))),
    ).toEqual([])
  })

  it('refuses generation reloads outside development', async () => {
    const { runtime, worker, boot } = createHarness('production')
    boot(worker('first'))
    await Effect.runPromise(Deferred.await(runtime.ready))
    expect(runtime.refusal()).toBe(
      'Worker generation reload is only available in development',
    )
  })
})
