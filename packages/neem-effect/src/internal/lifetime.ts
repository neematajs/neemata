import { normalizeError } from '@nmtjs/neem/internal/utils'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'

/**
 * An absolute point by which a release must be done. One is set by the stop
 * (or replacement) that starts a release and shared by everything it closes,
 * so nested steps never restart the clock.
 */
const liveClock = Effect.runSync(Clock.Clock)

export class Deadline {
  /** Monotonic milliseconds, meaningful only with this deadline's clock. */
  readonly at: number

  private readonly clock: Clock.Clock
  constructor(at: number, clock: Clock.Clock = liveClock) {
    this.clock = clock
    this.at = at
  }

  static after(ms: number, clock: Clock.Clock = liveClock): Deadline {
    return new Deadline(
      Number(clock.monotonicTimeNanosUnsafe()) / 1e6 + ms,
      clock,
    )
  }

  static make(ms: number): Effect.Effect<Deadline> {
    return Clock.clockWith((clock) => Effect.succeed(Deadline.after(ms, clock)))
  }

  remaining(): number {
    return Math.max(
      0,
      this.at - Number(this.clock.monotonicTimeNanosUnsafe()) / 1e6,
    )
  }
}

/**
 * Waits for `effect` until the deadline: `None` once it passes. The effect is
 * interrupted, so it must be a wait the release does not own (a promise, a
 * deferred, another fiber); waiting on a scope close this way would hang, since
 * closing is uninterruptible.
 */
export const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: Deadline,
): Effect.Effect<Option.Option<A>, E, R> =>
  Number.isFinite(deadline.at)
    ? Effect.timeoutOption(effect, deadline.remaining())
    : Effect.asSome(effect)

/**
 * Runs a release step bounded by the deadline. A failure or a missed deadline
 * becomes a defect of the release, so the scope that runs it reports it while
 * its remaining finalizers still run.
 */
export const releaseStep = <E, R>(
  label: string,
  effect: Effect.Effect<unknown, E, R>,
  deadline: Deadline,
): Effect.Effect<void, never, R> =>
  within(effect, deadline).pipe(
    Effect.flatMap((done) =>
      Option.isSome(done)
        ? Effect.void
        : Effect.die(
            new Error(`${label} did not finish within the stop budget`),
          ),
    ),
    Effect.catch((error) => Effect.die(normalizeError(error))),
  )

/**
 * A scope plus the deadline its finalizers spend. Finalizers registered here
 * are expected to bound themselves by `deadline()`, which is what lets every
 * close be awaited directly. A child lifetime closed through its parent spends
 * the parent's deadline.
 */
export class Lifetime {
  readonly scope: Scope.Closeable
  private readonly parent: Lifetime | undefined
  private readonly stopTimeout: number
  private given: Deadline | undefined
  clock: Clock.Clock = liveClock

  private constructor(
    scope: Scope.Closeable,
    parent: Lifetime | undefined,
    stopTimeout: number,
  ) {
    this.scope = scope
    this.parent = parent
    this.stopTimeout = stopTimeout
  }

  static make(
    stopTimeout: number,
    strategy?: 'sequential' | 'parallel',
  ): Lifetime {
    return new Lifetime(Scope.makeUnsafe(strategy), undefined, stopTimeout)
  }

  /** A child scope: closed with this one, or alone with its own deadline. */
  fork(strategy?: 'sequential' | 'parallel'): Lifetime {
    const child = new Lifetime(
      Scope.forkUnsafe(this.scope, strategy),
      this,
      this.stopTimeout,
    )
    child.clock = this.clock
    return child
  }

  get closed(): boolean {
    return this.scope.state._tag === 'Closed'
  }

  /** The deadline a finalizer of this lifetime runs against. */
  deadline(): Deadline {
    // A finalizer that runs without a close that gave a deadline (a late
    // acquisition in a scope closed by interruption) gets a stop budget.
    return (this.given ??=
      this.inherited() ?? Deadline.after(this.stopTimeout, this.clock))
  }

  private inherited(): Deadline | undefined {
    return this.given ?? this.parent?.inherited()
  }

  /**
   * Closes the scope, first deadline wins. Resolves with every release
   * failure; it never fails itself, so a caller can always report them all.
   */
  close(deadline: Deadline): Effect.Effect<readonly Error[]> {
    return Effect.suspend(() => {
      this.given ??= deadline
      return Effect.exit(Scope.close(this.scope, Exit.void))
    }).pipe(
      Effect.map((exit) =>
        Exit.isFailure(exit) ? causeErrors(exit.cause) : [],
      ),
    )
  }
}

/** Every failure and defect in a cause, as errors; interruptions are not failures. */
export function causeErrors(cause: Cause.Cause<unknown>): Error[] {
  const errors: Error[] = []
  for (const reason of cause.reasons) {
    if (Cause.isFailReason(reason)) errors.push(normalizeError(reason.error))
    else if (Cause.isDieReason(reason))
      errors.push(normalizeError(reason.defect))
  }
  return errors
}

/**
 * Calls user code that may return a promise. A synchronous throw and a
 * rejection both become the failure; interruption stops waiting for it, it
 * does not cancel it.
 */
export const attempt = <A>(
  evaluate: () => A | PromiseLike<A>,
): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: async () => evaluate(), catch: normalizeError })

/**
 * Closes a scope in a fiber of its own and waits for it until the deadline.
 * Closing is uninterruptible, so a missed deadline leaves it running.
 */
export const closeWithin = (
  label: string,
  scope: Scope.Closeable,
  deadline: Deadline,
): Effect.Effect<readonly Error[]> =>
  Effect.gen(function* () {
    const closing = yield* Effect.forkDetach(Scope.close(scope, Exit.void))
    const exit = yield* within(Fiber.await(closing), deadline)
    if (Option.isNone(exit)) {
      return [new Error(`${label} did not finish within the stop budget`)]
    }
    return Exit.isFailure(exit.value) ? causeErrors(exit.value.cause) : []
  })

/** A child scope whose arbitrary finalizers cannot extend the parent's deadline. */
export const boundedScope = (lifetime: Lifetime, label: string) =>
  Effect.gen(function* () {
    const scope = Scope.makeUnsafe()
    yield* Scope.addFinalizer(
      lifetime.scope,
      Effect.suspend(() =>
        closeWithin(label, scope, lifetime.deadline()).pipe(
          Effect.flatMap((errors) =>
            errors.length
              ? Effect.die(
                  new AggregateError(errors, `${label} did not stop cleanly`),
                )
              : Effect.void,
          ),
        ),
      ),
    )
    return scope
  })
