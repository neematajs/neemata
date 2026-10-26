import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Formatter from 'effect/Formatter'
import * as Option from 'effect/Option'

import type { AttemptResult } from '../instrumentation.ts'
import type { AttemptCommand, StoredError } from '../model.ts'
import type { AttemptInfo, Registry, StopReason } from '../program.ts'
import type { Claim } from '../store.ts'
import { begin, settle } from '../engine.ts'
import { CleanupTimeout, StaleClaim, StorageError } from '../errors.ts'
import { Instrumentation } from '../instrumentation.ts'
import { errorLike, parseDurationMs, storedError } from '../model.ts'
import { ending } from '../plan/attempt.ts'
import { stopTopic } from '../plan/draft.ts'
import { Store } from '../store.ts'
import { backoffMs, surviving } from './pool.ts'

/** What a failure said, when it does not read as an error with a message. */
const said = (error: unknown) =>
  typeof error === 'string' ? error : Formatter.formatJson(error)

/**
 * What a handler failed with, as it is stored. One failure or one defect is
 * stored as the error it is. A cause of more, a failure beside the defect of
 * a finalizer for one, is stored whole as its rendering: picking one of them
 * would lose the others.
 */
function failure(cause: Cause.Cause<unknown>): StoredError {
  const [reason, ...others] = cause.reasons
  const single = others.length === 0 && reason !== undefined
  if (!single || Cause.isInterruptReason(reason)) {
    return { name: 'WorkflowHandlerError', message: Cause.pretty(cause) }
  }
  const error = Cause.isFailReason(reason) ? reason.error : reason.defect
  if (!errorLike(error)) return { message: said(error) }
  const stored = storedError(error)
  // A tagged error says what happened in its fields, and has no message.
  return stored.message === '' ? { ...stored, message: said(error) } : stored
}

/**
 * Interrupts a handler and waits for it to end, finalizers included, but not
 * for longer than the worker allows: a handler that does not yield to
 * interruption must not hold its worker forever. It is not waited for by
 * anything else, so one that overruns is simply left behind.
 */
const stop = (fiber: Fiber.Fiber<unknown, unknown>, cleanupTimeoutMs: number) =>
  Effect.suspend(() => {
    fiber.interruptUnsafe()
    return Effect.timeoutOption(Fiber.await(fiber), cleanupTimeoutMs)
  }).pipe(
    Effect.flatMap((ended) =>
      Option.isSome(ended)
        ? Effect.void
        : Effect.fail(new CleanupTimeout({ timeoutMs: cleanupTimeoutMs })),
    ),
  )

/** What an attempt's command failed with, as instrumentation is told. */
function failedWith(cause: Cause.Cause<unknown>): AttemptResult {
  const error = cause.reasons.find(Cause.isFailReason)?.error
  if (error instanceof StaleClaim)
    return { kind: 'stopped', reason: 'claimLost' }
  return {
    kind: 'error',
    error:
      error instanceof StorageError
        ? 'storage'
        : error instanceof CleanupTimeout
          ? 'cleanupTimeout'
          : 'defect',
    cause,
  }
}

/**
 * Tells instrumentation how the attempt ended, once it has: the attempt's
 * own exit goes on as it was, whatever the hook does.
 */
const reported = <E, R>(
  { attemptEnded }: Instrumentation,
  attempt: AttemptInfo,
  work: Effect.Effect<AttemptResult, E, R>,
): Effect.Effect<void, E, R> =>
  attemptEnded
    ? Effect.flatMap(Effect.exit(work), (exit) =>
        Effect.suspend(() =>
          attemptEnded(
            attempt,
            Exit.isSuccess(exit) ? exit.value : failedWith(exit.cause),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('Workflow instrumentation failed', cause),
          ),
          Effect.andThen(Exit.asVoid(exit)),
        ),
      )
    : Effect.asVoid(work)

export type AttemptOptions = {
  readonly leaseMs: number
  readonly cleanupTimeoutMs: number
}

/**
 * Works a claimed attempt to its end: starts it, runs its handler under a
 * heartbeat and its time limit, and settles what the handler came to.
 *
 * Only the handler is interruptible. Interrupted because the worker is
 * stopping, it has no outcome and its command is given back; stopped by the
 * heartbeat, it has none either. Every write here runs to its end, and none
 * is waited for before the handler is told to stop.
 *
 * It fails only with `CleanupTimeout`: the handler was told to stop and did
 * not. Nothing is settled or given back then, as the work may still be going
 * on: the command is delivered again when its lease ends.
 */
export const runAttempt =
  <R>(registry: Registry, { leaseMs, cleanupTimeoutMs }: AttemptOptions) =>
  (
    claim: Claim<AttemptCommand>,
  ): Effect.Effect<void, CleanupTimeout, Store | R> =>
    Effect.gen(function* () {
      const store = yield* Store
      const { command } = claim
      const { runId, nodeName, attemptId } = command

      const begun = yield* begin(registry, claim)
      if (begun._tag === 'Stale') return
      if (begun._tag === 'Unroutable') {
        return yield* store.release(claim, {
          error:
            begun.error ??
            new Error(
              `No registered code runs attempt [${attemptId}] of [${runId}.${nodeName}]`,
            ),
          delayMs: backoffMs(claim),
        })
      }
      const { execute, timeout } = begun.executable
      const instrumentation = yield* Instrumentation

      // Set by whatever ends the race below to stop the handler, before the
      // handler is told: its finalizers read it as they run. The first to
      // say stands, as the handler is told once; told with nothing said
      // while it runs, the worker itself is stopping.
      let reason: StopReason | undefined
      const attempt = {
        ...begun.attempt,
        stopReason: Effect.sync(() => reason),
      }
      const shutdown: AttemptResult = { kind: 'stopped', reason: 'shutdown' }

      return yield* reported(
        instrumentation,
        attempt,
        Effect.gen(function* () {
          // Told that the run was asked to stop or has ended. Subscribed before
          // the handler starts, so no request made while it runs is missed.
          const stopped = yield* store.listen(stopTopic(runId))

          // Beginning and subscribing were not interrupted. A worker that was
          // told to stop meanwhile learns it here, before any of the handler
          // has run: the work goes back untouched.
          const stopping = yield* Effect.exit(Effect.interruptible(Effect.void))
          if (Exit.isFailure(stopping)) {
            yield* store.release(claim)
            return shutdown
          }

          // Programs erase what their handlers require: the worker's `R` is the
          // promise that it is provided. A handler owns a scope for its
          // attempt, inside whatever instrumentation wraps it in.
          const scoped = Effect.scoped(
            Effect.suspend(() => execute(command.input, attempt)),
          )
          // Called in the handler's fiber, where what it throws is the
          // handler's failure.
          const { handler: around } = instrumentation
          const handler = (
            around ? Effect.suspend(() => around(attempt, scoped)) : scoped
          ) as Effect.Effect<unknown, unknown, R>
          // Detached, so that nothing waits for it but `stop`, which gives up.
          const fiber = yield* Effect.forkDetach(handler, {
            startImmediately: true,
          })
          const timeoutMs = parseDurationMs(timeout)

          // Ends only to stop the handler, which then has no outcome: the claim
          // was lost to another delivery, or the run no longer wants the work.
          // Renewing is a write, so only the pause between two is
          // interruptible. The pause ends early on a hint that the run is
          // stopping: the renewal that follows is what says so, the hint only
          // brings it forward.
          const heartbeat = Effect.gen(function* () {
            for (;;) {
              yield* Effect.raceFirst(Effect.sleep(leaseMs / 3), stopped)
              const unwanted = yield* Effect.exit(
                Effect.uninterruptible(store.renew(claim, leaseMs)).pipe(
                  Effect.map(ending),
                  // A renewal the store could not make loses nothing yet: the
                  // lease outlasts it, and the next beat tries again.
                  Effect.catchTag('StorageError', () => Effect.succeed(false)),
                ),
              )
              if (Exit.isSuccess(unwanted)) {
                if (unwanted.value) {
                  reason ??= 'cancelled'
                  return 'unwanted' as const
                }
              } else if (Cause.hasFails(unwanted.cause)) {
                reason ??= 'claimLost'
                return 'lost' as const
              }
            }
          })
          const limit =
            timeoutMs === undefined
              ? Effect.never
              : Effect.map(Effect.sleep(timeoutMs), () => {
                  reason ??= 'timedOut'
                  return 'timedOut' as const
                })

          // The handler is told to stop once, in a fiber of its own, and that
          // fiber is what is waited for afterwards: the time the handler has to
          // end counts from when it was told, whatever else is waited for
          // first.
          let told: Fiber.Fiber<void, CleanupTimeout> | undefined
          const telling = Effect.suspend(() => {
            // A handler that has ended was not stopped, whatever ends the race.
            if (fiber.pollUnsafe() === undefined) reason ??= 'shutdown'
            return told
              ? Effect.succeed(told)
              : Effect.map(
                  Effect.forkDetach(stop(fiber, cleanupTimeoutMs), {
                    startImmediately: true,
                  }),
                  (stopping) => (told = stopping),
                )
          })
          const halted = Effect.flatMap(telling, Fiber.join)

          // Interrupted with the others when the race below is over, whatever
          // ended it, and tells the handler to stop at that moment. The race
          // goes on to wait for a renewal under way, which is a write and may
          // take long: the handler must not run on until it returns, nor have
          // until then to end.
          const halt = Effect.onInterrupt(Effect.never, () => telling)

          // Whichever ends first interrupts the others, in one race: a race of
          // its own for the limit and the heartbeat would wait for the renewal
          // before this one learned that the limit had passed.
          const ran = yield* Effect.exit(
            Effect.interruptible(
              Effect.raceAllFirst([Fiber.await(fiber), limit, heartbeat, halt]),
            ),
          )
          // None of them fails, so this is interruption: the worker is
          // stopping, and the work goes back for another.
          if (Exit.isFailure(ran)) {
            yield* halted
            yield* store.release(claim)
            return shutdown
          }

          const ended = ran.value
          if (Exit.isExit(ended)) {
            if (Exit.isSuccess(ended)) {
              const settlement = yield* settle(registry, claim, {
                _tag: 'Completed',
                output: ended.value,
              })
              return {
                kind: 'settlement',
                execution: 'completed',
                // A success is never tried again.
                settlement: settlement === 'stale' ? 'stale' : 'settled',
              } satisfies AttemptResult
            }
            const error = failure(ended.cause)
            const settlement = yield* settle(registry, claim, {
              _tag: 'Failed',
              error,
            })
            return {
              kind: 'settlement',
              execution: 'failed',
              settlement,
              error,
            } satisfies AttemptResult
          }

          // A handler that ends while it is being stopped has no outcome: what
          // stopped it stands, even against a success that came at that
          // instant.
          yield* halted
          if (ended === 'lost') {
            return {
              kind: 'stopped',
              reason: 'claimLost',
            } satisfies AttemptResult
          }
          if (ended === 'unwanted') {
            // The heartbeat read without a guard, so the plan is asked again
            // and drops the command. Should the attempt count after all, it is
            // delivered again when this claim's lease ends.
            yield* begin(registry, claim)
            return {
              kind: 'stopped',
              reason: 'cancelled',
            } satisfies AttemptResult
          }
          const error = {
            name: 'AttemptTimeout',
            message: `Attempt [${attemptId}] of [${runId}.${nodeName}] timed out after ${timeout}`,
          }
          const settlement = yield* settle(registry, claim, {
            _tag: 'TimedOut',
            error,
          })
          return {
            kind: 'settlement',
            execution: 'timedOut',
            settlement,
            error,
          } satisfies AttemptResult
        }),
      )
    }).pipe(
      Effect.scoped,
      // A claim that is no longer held is another delivery's to work.
      Effect.catchTag('StaleClaim', () => Effect.void),
      surviving(claim),
    )
