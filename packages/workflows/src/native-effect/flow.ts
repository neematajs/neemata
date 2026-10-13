import type * as Duration from 'effect/Duration'
import type { Concurrency } from 'effect/Types'
import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import {
  DurableClock,
  DurableDeferred,
  Workflow,
  WorkflowEngine,
} from 'effect/workflow'

export type ForEachOptions<T> = {
  /** Stable identity of an item; it becomes part of each checkpoint name. */
  readonly key: (item: T, index: number) => string
  readonly concurrency?: Concurrency
}

/**
 * A signal was completed with an Exit that holds nothing but an interruption.
 * The engine suspends and preempts a run by interrupting it, so a workflow
 * cannot receive an interruption as an answer. `signal` fails with this
 * instead of storing one; `awaitWithin` dies with it on finding one stored by
 * other means, such as `DurableDeferred.done`.
 */
export class SignalInterrupted extends Data.TaggedError('SignalInterrupted')<{
  readonly executionId: string
  // Not `name`: a stored defect keeps only an error's name and message, and
  // a field called `name` would replace the error's own.
  readonly signal: string
}> {
  override get message() {
    return `Signal "${this.signal}" of execution ${this.executionId} was completed with an interruption and nothing else, which a workflow cannot receive as an answer`
  }
}

/**
 * Separates a failure from a suspension by the engine's own rule: a cause is
 * a suspension only when it holds nothing but interruptions. That cause comes
 * back as the failure. Any other comes back without its interruptions, as the
 * engine drops them before it stores a result.
 */
function withoutInterrupts<E>(
  cause: Cause.Cause<E>,
): Result.Result<Cause.Cause<E>, Cause.Cause<never>> {
  const interrupts: Cause.Interrupt[] = []
  const rest: Cause.Reason<E>[] = []

  for (const reason of cause.reasons) {
    if (Cause.isInterruptReason(reason)) {
      interrupts.push(reason)
    } else {
      rest.push(reason)
    }
  }

  if (interrupts.length === 0) return Result.succeed(cause)
  if (rest.length === 0) return Result.fail(Cause.fromReasons(interrupts))
  return Result.succeed(Cause.fromReasons(rest))
}

/**
 * Captures how an effect ended, unless it was suspended. A wait that parks on
 * another fiber of the effect, such as a branch of `Effect.all`, reaches this
 * one as a failure. Captured as an ordinary failed Exit, it would let the body
 * carry on past a wait that never finished.
 *
 * Only an interruption with nothing beside it is passed on. A failure that
 * carries one, as a stored signal outcome can, is the effect's own result.
 */
function settle<A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Exit.Exit<A, E>, never, R> {
  return Effect.matchCauseEffect(effect, {
    onSuccess: (value) => Effect.succeed(Exit.succeed(value)),
    onFailure: (cause) =>
      Result.match(withoutInterrupts(cause), {
        onFailure: (suspension) => Effect.failCause(suspension),
        onSuccess: (failure) => Effect.succeed(Exit.failCause(failure)),
      }),
  })
}

/**
 * Runs `body` for every item and settles all of them, returning one Exit per
 * item in input order. A failed item does not stop its siblings.
 *
 * `body` receives `${name}/${key}` and must use it for the steps and calls it
 * makes, so that items never share a checkpoint. While any item is still
 * waiting the workflow suspends; the Exits are returned only once every item
 * has finished.
 */
export function forEach<T, A, E, R>(
  name: string,
  items: Iterable<T>,
  options: ForEachOptions<T>,
  body: (item: T, name: string) => Effect.Effect<A, E, R>,
) {
  return Effect.forEach(
    items,
    (item, index) => settle(body(item, `${name}/${options.key(item, index)}`)),
    { concurrency: options.concurrency ?? 'unbounded' },
  )
}

/** A sleep the engine schedules, so it outlives the process that started it. */
export function sleep(name: string, duration: Duration.Input) {
  // A threshold of zero keeps even short sleeps out of process memory, where
  // a restart would begin them again.
  return DurableClock.sleep({ name, duration, inMemoryThreshold: 0 })
}

/**
 * Records a signal outcome or deadline under `name`: the signal's value as
 * `Some`, its failure as this effect's failure, or `None` for the deadline.
 * Every replay takes that same branch. If both outcomes are available when
 * the deadline is evaluated, the stored signal takes precedence.
 *
 * A signal's failure is received without the interruptions stored in it. One
 * that holds nothing else is no answer: the wait dies with `SignalInterrupted`.
 */
export function awaitWithin<
  Success extends Schema.Constraint,
  Error extends Schema.Constraint,
>(
  name: string,
  signal: DurableDeferred.DurableDeferred<Success, Error>,
  timeout: Duration.Input,
) {
  // Both arms hand over the Exit the signal was completed with as a value.
  // `DurableDeferred.await` would run it on the workflow's fiber instead,
  // where a stored interruption reads like the engine suspending the run. A
  // value also lets a failed signal win the race: `raceAll` takes the first
  // success, so a failing arm would lose to a deadline that has also passed.
  const arrived = Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const instance = yield* WorkflowEngine.WorkflowInstance
    // Listed before the read, as `DurableDeferred.await` does it, so that a
    // completion landing in between preempts the run instead of being missed.
    // Effect counts the waits on a name and takes its own back when the race
    // around them settles. That bookkeeping is private, so this one stays
    // counted for the rest of the pass: a completion after the deadline won
    // can still preempt the run, which then replays from its checkpoints.
    const waits = instance.awaitedDeferreds
    waits.set(signal.name, (waits.get(signal.name) ?? 0) + 1)
    const stored = yield* Workflow.wrapActivityResult(
      engine.deferredResult(signal),
      (outcome) => Option.isNone(outcome),
    )
    if (Option.isNone(stored)) return yield* Workflow.suspend(instance)
    return stored
  })
  const expired = Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* sleep(`${name}/deadline`, timeout)
    // The engine keeps no order between a signal and a timer that both
    // finished before this pass. Reading the signal here gives both arms the
    // same answer, so the outcome does not depend on which one is quicker.
    return yield* engine.deferredResult(signal)
  })

  return Effect.gen(function* () {
    const outcome = yield* DurableDeferred.raceAll({
      name,
      success: Schema.Option(
        Schema.Exit(signal.successSchema, signal.errorSchema, Schema.Defect()),
      ),
      error: Schema.Never,
      effects: [arrived, expired],
    })
    if (Option.isNone(outcome)) return Option.none()

    const exit = outcome.value
    if (Exit.isSuccess(exit)) return Option.some(exit.value)

    const failure = withoutInterrupts(exit.cause)
    if (Result.isSuccess(failure)) {
      return yield* Effect.failCause(failure.success)
    }

    const { executionId } = yield* WorkflowEngine.WorkflowInstance
    const interrupted = new SignalInterrupted({
      executionId,
      signal: signal.name,
    })
    return yield* Effect.die(interrupted)
  })
}
