import type * as Duration from 'effect/Duration'
import type * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Result from 'effect/Result'
import { Activity, DurableDeferred, WorkflowEngine } from 'effect/workflow'

import { sleep } from './flow.ts'
import { claimName, withinStep } from './names.ts'

type Engine = WorkflowEngine.WorkflowEngine
type Instance = WorkflowEngine.WorkflowInstance

export type Retry<E> = {
  /** Attempts allowed after the first one, per budget. */
  readonly times: number
  /** Typed failures that are worth another attempt; all of them by default. */
  readonly while?: (error: E) => boolean
  /** Delay before the attempt that follows failed attempt `attempt`. */
  readonly backoff?: (attempt: number) => Duration.Input
}

export type StepOptions<
  Success extends Schema.Constraint,
  Error extends Schema.Constraint,
  R,
> = {
  readonly name: string
  readonly success?: Success
  readonly error?: Error
  readonly execute: Effect.Effect<Success['Type'], Error['Type'], R>
  readonly retry?: Retry<Error['Type']>
  /**
   * Suspend instead of failing once the step has no attempts left, until
   * `retryStep` grants a new budget. Completed steps keep their results.
   */
  readonly park?: boolean
}

/** The signal that reopens a parked step for its next budget. */
export function retryGate(name: string, budget: number) {
  return DurableDeferred.make(`nmtjs/retry/${name}/${budget}`)
}

/** Recorded when a step parks, so a client can tell which budget is waiting. */
export function parkedMarker(name: string, budget: number) {
  return DurableDeferred.make(`nmtjs/parked/${name}/${budget}`)
}

function awaitRetry(name: string, budget: number) {
  return Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine
    const marker = parkedMarker(name, budget)

    // A replay reaches this point again; completing twice would only add a
    // redundant journal write.
    const marked = yield* engine.deferredResult(marker)
    if (Option.isNone(marked)) {
      const token = yield* DurableDeferred.token(marker)
      yield* DurableDeferred.succeed(marker, { token, value: undefined })
    }

    yield* DurableDeferred.await(retryGate(name, budget))
  })
}

/**
 * A named checkpoint: the body runs until it produces a result, and a replay
 * returns that stored result without running it again.
 *
 * Every attempt is its own checkpoint, so retries move forward on replay
 * instead of returning the first recorded failure. Backoff is a durable sleep
 * and survives a restart. Only typed failures are retried.
 *
 * The body is plain work: a `step` or `call` inside it fails the workflow
 * with a `NestedCheckpoint` defect.
 */
export function step<
  Success extends Schema.Constraint = Schema.Void,
  Error extends Schema.Constraint = Schema.Never,
  R = never,
>(
  options: StepOptions<Success, Error, R>,
): Effect.Effect<
  Success['Type'],
  Error['Type'],
  | Exclude<R, Engine | Instance | Scope.Scope>
  // The result is written as well as read back, and `Activity` declares only
  // the services that read it.
  | Success['DecodingServices']
  | Success['EncodingServices']
  | Error['DecodingServices']
  | Error['EncodingServices']
  | Engine
  | Instance
> {
  const { name, retry, park = false } = options
  const activity = Activity.make({
    name,
    success: options.success,
    error: options.error,
    execute: withinStep(name, options.execute),
  })
  const attempts = 1 + (retry?.times ?? 0)

  return Effect.gen(function* () {
    const instance = yield* WorkflowEngine.WorkflowInstance
    yield* claimName(instance, name)

    let attempt = 1
    let budget = 1
    let left = attempts

    while (true) {
      const result = yield* Effect.result(
        Effect.provideService(activity, Activity.CurrentAttempt, attempt),
      )
      if (Result.isSuccess(result)) return result.success

      const error = result.failure
      left--
      const retryable = retry?.while?.(error) ?? true

      if (left > 0 && retryable) {
        const delay = retry?.backoff?.(attempt)
        // Scheduled by the engine even when short: an in-process sleep would
        // start over if the runner were replaced while waiting.
        if (delay !== undefined) {
          yield* sleep(`${name}/backoff/${attempt}`, delay)
        }
      } else {
        if (!park) return yield* Effect.fail(error)

        yield* awaitRetry(name, budget)
        budget++
        left = attempts
      }

      attempt++
    }
  })
}
