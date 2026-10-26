import type * as Cause from 'effect/Cause'
import type * as Effect from 'effect/Effect'
import * as Context from 'effect/Context'

import type { Headers, Route, RunKind, StoredError } from './model.ts'
import type { Settled } from './plan/attempt.ts'
import type { Started } from './plan/start.ts'
import type { AttemptInfo } from './program.ts'

/** A start as instrumentation sees it, before it is made. */
export type StartRequest = Route & {
  readonly kind: RunKind
  /** What the caller gave, if anything. */
  readonly headers?: Headers
}

/**
 * How a begun attempt ended for its worker. What the handler came to and
 * what settling it recorded are apart: a failure that is `settled` is one no
 * retry follows, not necessarily the end of the run, and one that is `stale`
 * counted for nothing, as the attempt no longer did.
 */
export type AttemptResult =
  | {
      readonly kind: 'settlement'
      readonly execution: 'completed'
      readonly settlement: Exclude<Settled, 'retrying'>
    }
  | {
      readonly kind: 'settlement'
      readonly execution: 'failed' | 'timedOut'
      readonly settlement: Settled
      readonly error: StoredError
    }
  /** Nothing was recorded; see `StopReason`. */
  | {
      readonly kind: 'stopped'
      readonly reason: 'cancelled' | 'claimLost' | 'shutdown'
    }
  /**
   * The worker failed the attempt's command. After `storage`, whether the
   * last write was committed is not known; after `cleanupTimeout`, the
   * handler may still be running.
   */
  | {
      readonly kind: 'error'
      readonly error: 'storage' | 'cleanupTimeout' | 'defect'
      readonly cause: Cause.Cause<unknown>
    }

/**
 * Where an application observes the engine: it traces, measures and logs
 * the work there as it chooses, and the engine does none of it itself. Every
 * hook is optional. What a hook needs it is given when its layer is built.
 *
 * The wrappers are trusted: each runs its continuation once and gives back
 * what it gave, and what they fail with is the caller's or the handler's.
 */
export type Instrumentation = {
  /**
   * Around every `Client.start` (and `restart`, which starts): it decides
   * the headers kept with a run it creates, such as the caller's trace
   * context. `Started.created` is false when an existing run answered,
   * which keeps its own headers.
   */
  readonly start?: <E, R>(
    request: StartRequest,
    next: (headers: Headers | undefined) => Effect.Effect<Started, E, R>,
  ) => Effect.Effect<Started, E, R>
  /**
   * Around the handler of every attempt, in the handler's fiber: a span
   * opened here is the parent of the handler's own. It ends with the
   * handler, before the attempt is settled, and is interrupted with it:
   * `attempt.stopReason` then says why.
   */
  readonly handler?: <A, E, R>(
    attempt: AttemptInfo,
    run: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  /**
   * Once for every delivery of an attempt that began, when its worker is
   * done with it: an attempt delivered again, after its claim was lost or
   * its worker stopped, is reported again. Runs before the worker takes
   * other work in its place, so it should not wait; what it fails with is
   * logged and ignored.
   */
  readonly attemptEnded?: (
    attempt: AttemptInfo,
    result: AttemptResult,
  ) => Effect.Effect<void>
}

/** Nothing by default: provide one with `Layer.succeed`. */
export const Instrumentation = Context.Reference<Instrumentation>(
  '@nmtjs/workflows/Instrumentation',
  { defaultValue: () => ({}) },
)
