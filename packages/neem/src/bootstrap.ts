import type { NeemRuntimeServerHealth } from './shared/types.ts'
export type RunHostOptions = {
  signal: AbortSignal
  onReady?: (health: NeemRuntimeServerHealth) => void
  onFailure?: (error: Error) => void
  onStopped?: () => void
}
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type { RuntimeSnapshot } from './internal/manifest/snapshot.ts'
import { lifecycleOf } from './internal/context.ts'
import { Host } from './internal/host.ts'
import { Deadline } from './internal/lifetime.ts'
import { flushLogger } from './internal/logger.ts'
import { runPromise } from './internal/run.ts'

/**
 * The production lifecycle of `neem start` and a standalone start.js:
 * serve until the signal aborts or a runtime failure recovery cannot repair
 * brings the server down. The first error wins; a failed stop rejects too.
 */
export async function runHostUntilClosed(
  snapshot: RuntimeSnapshot,
  options: RunHostOptions,
): Promise<void> {
  const { signal } = options
  if (signal.aborted) return

  const failure = Deferred.makeUnsafe<never, Error>()
  const aborted = Deferred.makeUnsafe<void>()
  const onAbort = () => Deferred.doneUnsafe(aborted, Effect.void)
  signal.addEventListener('abort', onAbort, { once: true })
  const host = new Host({
    snapshot,
    failOnWorkerError: true,
    onFailure: (error) => {
      options.onFailure?.(error)
      Deferred.doneUnsafe(failure, Effect.fail(error))
    },
  })

  const program = Effect.gen(function* () {
    const serve = host.start().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (!signal.aborted) options.onReady?.(host.getHealth())
        }),
      ),
      Effect.andThen(Deferred.await(failure)),
    )
    // A signal during startup stops waiting for it; the stop below
    // interrupts the start itself and owns the cleanup.
    const served = yield* Effect.exit(
      Effect.raceFirst(serve, Deferred.await(aborted)),
    )
    signal.removeEventListener('abort', onAbort)
    const deadline = yield* Deadline.make(lifecycleOf(snapshot).stopTimeout)
    const stopped = yield* Effect.exit(host.stop(deadline))
    if (Exit.isSuccess(stopped)) options.onStopped?.()
    // A failed run ends in process.exit (the CLI) or an unhandled rejection
    // (start.js), either of which drops what async log destinations buffer.
    yield* Effect.promise(() =>
      flushLogger(snapshot.logger, deadline.remaining()),
    )
    if (Exit.isFailure(served)) return yield* served
    return yield* stopped
  })

  await runPromise(program)
}
