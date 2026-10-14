import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FiberSet from 'effect/FiberSet'
import * as Latch from 'effect/Latch'

import type { Command } from '../model.ts'
import type { Claim, Lane } from '../store.ts'
import { StorageError } from '../errors.ts'
import { Store } from '../store.ts'

export type PoolOptions = {
  /** Commands worked on at once; 1 when omitted. */
  readonly concurrency?: number
  /**
   * How long a claim is held without being renewed: what a crashed worker
   * costs before its work is delivered again. 30 seconds when omitted.
   */
  readonly leaseMs?: number
  /**
   * How often an idle worker looks for work no hint announced, such as a
   * command that has become due. 250 milliseconds when omitted.
   */
  readonly pollMs?: number
}

export function resolve(options: PoolOptions): Required<PoolOptions> {
  const { concurrency = 1, leaseMs = 30_000, pollMs = 250 } = options
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Worker concurrency must be a positive integer')
  }
  for (const [name, value] of Object.entries({ leaseMs, pollMs })) {
    if (!(value > 0)) throw new Error(`Worker ${name} must be positive`)
  }
  return { concurrency, leaseMs, pollMs }
}

/** A release that counts against the command waits longer each time. */
export function backoffMs({ deliveries }: Claim) {
  return Math.min(1_000 * 2 ** (deliveries - 1), 300_000)
}

/**
 * Gives back a command the engine failed on, with what went wrong, so it is
 * delivered again, later each time, and set aside if that keeps happening. A
 * worker outlives any one command.
 *
 * A storage failure is the command's too: the store may have failed this
 * one write only, and a write it refuses every time must not be tried
 * forever. When the store is down the release fails as well, nothing is
 * counted, and the command comes back when its lease ends.
 */
export const surviving =
  (claim: Claim) =>
  <E, R>(
    effect: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, Exclude<E, StorageError>, Store | R> =>
    Effect.catchCause(effect, (cause: Cause.Cause<E>) =>
      // Any other failure is the worker's own to end with.
      cause.reasons.some(
        (reason) =>
          Cause.isFailReason(reason) && !(reason.error instanceof StorageError),
      )
        ? Effect.failCause(cause as Cause.Cause<Exclude<E, StorageError>>)
        : Effect.flatMap(Store, (store) =>
            Effect.logError('Workflow command failed', cause).pipe(
              Effect.andThen(
                store.release(claim, {
                  error: Cause.squash(cause),
                  delayMs: backoffMs(claim),
                }),
              ),
              Effect.catchCause(() => Effect.void),
            ),
          ),
    )

/**
 * Claims commands and hands each to `handle` in a fiber of its own, never
 * more than `concurrency` at once, until interrupted. Interruption stops the
 * claiming and interrupts the fibers, and is over when they are.
 *
 * Everything but the waiting is uninterruptible, `handle` included: a claimed
 * command always reaches it, and it alone decides what of its work may be
 * interrupted and gives back what it then cannot finish.
 *
 * A `handle` that fails ends the pool with its failure, once the commands in
 * hand were given back: it is how a worker says it cannot go on. That holds
 * for a pool that is interrupted too, whose handlers fail only as they are
 * stopped: its failure then carries theirs beside the interruption, so that
 * whoever stopped it knows the stop was not a clean one.
 */
export const pool = <K extends Command['kind'], E, R>(
  lanes: readonly Lane<K>[],
  { concurrency, leaseMs, pollMs }: Required<PoolOptions>,
  handle: (
    claim: Claim<Extract<Command, { kind: K }>>,
  ) => Effect.Effect<void, E, R>,
): Effect.Effect<never, E | StorageError, Store | R> =>
  Effect.uninterruptibleMask((restore) => {
    // Set by the first `handle` that fails, to what it failed with.
    let failure: Cause.Cause<E | StorageError> | undefined

    const claiming = Effect.gen(function* () {
      const store = yield* Store
      // A lane without routes can never be served.
      const served = lanes.filter(({ routes }) => routes.length > 0)
      const hint = yield* store.hints(served.map(({ kind }) => kind))
      const handlers = yield* FiberSet.make<void>()
      // Open while fewer than `concurrency` commands are in hand.
      const room = Latch.makeUnsafe(true)
      // Opened by the first `handle` that fails.
      const broken = Latch.makeUnsafe(false)
      let active = 0

      const run = (claim: Claim<Extract<Command, { kind: K }>>) => {
        active += 1
        if (active >= concurrency) room.closeUnsafe()
        return FiberSet.run(
          handlers,
          // What it fails with is caught inside: an interrupted fiber skips
          // every handler it meets once it may be interrupted again, and
          // the failure of a pool that is stopping would be lost with it.
          Effect.uninterruptible(
            handle(claim).pipe(
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  failure ??= cause
                  broken.openUnsafe()
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  active -= 1
                  room.openUnsafe()
                }),
              ),
            ),
          ),
        )
      }
      const waiting = (wait: Effect.Effect<void>) =>
        restore(Effect.raceFirst(wait, broken.await))

      for (;;) {
        yield* waiting(room.await)
        // Leaving closes the scope, which interrupts the handlers left.
        if (failure) return

        const limit = concurrency - active
        const claimed = yield* Effect.exit(
          store.claim({ lanes: served, limit, leaseMs }),
        )
        if (Exit.isFailure(claimed)) {
          // The store failed this worker, not the work it holds: that is
          // finished first, and the failure is then the worker's own.
          yield* restore(FiberSet.awaitEmpty(handlers))
          return yield* Effect.failCause(claimed.cause)
        }
        for (const claim of claimed.value) yield* run(claim)

        // Fewer than asked for: nothing more is due.
        if (claimed.value.length < limit) {
          yield* waiting(Effect.raceFirst(hint, Effect.sleep(pollMs)))
        }
      }
    }).pipe(Effect.scoped)

    // The scope has closed by now, so every handler has ended, and only now
    // is it known whether one failed: those of a pool that was interrupted
    // fail after the claiming has stopped looking.
    return Effect.flatMap(Effect.exit(claiming), (ended) =>
      Effect.failCause(
        Cause.combine(
          failure ?? Cause.empty,
          // The claiming ends without a cause only to say a handler failed.
          Exit.isFailure(ended) ? ended.cause : Cause.empty,
        ),
      ),
    )
  })
