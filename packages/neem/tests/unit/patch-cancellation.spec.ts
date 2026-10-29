import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { expect, it } from 'vitest'

import { WorkerRuntime } from '../../src/internal/worker/runtime.ts'

it('cancelling a queued patch cannot release the active patch permit', async () => {
  const runtime = new WorkerRuntime({
    mode: 'development',
    onFinished() {},
    onStartError() {},
    onCleanupError() {},
  })
  const release = Deferred.makeUnsafe<void>()
  const entered = Deferred.makeUnsafe<void>()
  const events: string[] = []
  const first = Effect.runFork(
    runtime.patch(
      Effect.gen(function* () {
        events.push('first:start')
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        events.push('first:end')
      }),
    ),
  )
  await Effect.runPromise(Deferred.await(entered))
  const cancelled = Effect.runFork(
    runtime.patch(Effect.sync(() => events.push('cancelled'))),
  )
  await Effect.runPromise(Fiber.interrupt(cancelled))
  const third = Effect.runFork(
    runtime.patch(Effect.sync(() => events.push('third'))),
  )
  try {
    // Let the successor run or suspend on the permit, while the first patch
    // deliberately remains active. No elapsed-time threshold is involved.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(events).toEqual(['first:start'])
  } finally {
    Deferred.doneUnsafe(release, Effect.void)
    await Effect.runPromise(Fiber.join(first))
    await Effect.runPromise(Fiber.join(third))
  }
  expect(events).toEqual(['first:start', 'first:end', 'third'])
})
