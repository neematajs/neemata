import type * as Schema from 'effect/Schema'
import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Match from 'effect/Match'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import { DurableDeferred, WorkflowEngine } from 'effect/workflow'

import type { Definition } from './definition.ts'
import { SignalInterrupted } from './flow.ts'
import { ExecutionId } from './ids.ts'
import { parkedMarker, retryGate } from './step.ts'

/**
 * What the engine has stored for an execution.
 *
 * `Pending` covers both an unknown id and a run that has not reached its first
 * stored result; the engine does not tell them apart. `Suspended` is a run
 * waiting on a signal, timer, child or parked step.
 */
export type Status<A, E> = Data.TaggedEnum<{
  Pending: {}
  Suspended: { readonly cause: Option.Option<Cause.Cause<never>> }
  Succeeded: { readonly value: A }
  Failed: { readonly cause: Cause.Cause<E> }
  Interrupted: {}
}>

interface StatusDefinition extends Data.TaggedEnum.WithGenerics<2> {
  readonly taggedEnum: Status<this['A'], this['B']>
}

export const Status = Data.taggedEnum<StatusDefinition>()

export class StepNotParked extends Data.TaggedError('StepNotParked')<{
  readonly executionId: string
  readonly name: string
}> {
  override get message() {
    return `Step "${this.name}" of execution ${this.executionId} is not parked`
  }
}

/** Starts an execution without waiting for it, or joins the one with the same key. */
export function start<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Definition<Name, Fields, Success, Error>,
  payload: Parameters<typeof definition.execute>[0],
) {
  return definition
    .execute(payload, { discard: true })
    .pipe(Effect.map((id) => ExecutionId.make(id)))
}

export function status<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(definition: Definition<Name, Fields, Success, Error>, executionId: string) {
  type A = Success['Type']
  type E = Error['Type']

  return definition.poll(executionId).pipe(
    Effect.map(
      Option.match({
        onNone: (): Status<A, E> => Status.Pending(),
        onSome: (result) =>
          Match.value(result).pipe(
            Match.withReturnType<Status<A, E>>(),
            Match.tag('Suspended', ({ cause }) =>
              Status.Suspended({ cause: Option.fromNullishOr(cause) }),
            ),
            Match.tag('Complete', ({ exit }) => settled<A, E>(exit)),
            Match.exhaustive,
          ),
      }),
    ),
  )
}

function settled<A, E>(exit: Exit.Exit<A, E>): Status<A, E> {
  if (Exit.isSuccess(exit)) return Status.Succeeded({ value: exit.value })
  if (Cause.hasInterruptsOnly(exit.cause)) return Status.Interrupted()
  return Status.Failed({ cause: exit.cause })
}

/**
 * Polls until the execution has a final result. The engine exposes no
 * completion subscription by id, so this is a client-side poll.
 */
export function awaitSettled<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Definition<Name, Fields, Success, Error>,
  executionId: string,
  schedule: Schedule.Schedule<unknown> = Schedule.spaced('250 millis'),
) {
  return status(definition, executionId).pipe(
    Effect.repeat({
      schedule,
      while: ({ _tag }) => _tag === 'Pending' || _tag === 'Suspended',
    }),
  )
}

function send<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  WSuccess extends Schema.Top,
  WError extends Schema.Top,
  Success extends Schema.Constraint,
  Error extends Schema.Constraint,
>(
  definition: Definition<Name, Fields, WSuccess, WError>,
  executionId: string,
  deferred: DurableDeferred.DurableDeferred<Success, Error>,
  exit: Exit.Exit<Success['Type'], Error['Type']>,
) {
  const token = DurableDeferred.tokenFromExecutionId(deferred, {
    workflow: definition,
    executionId,
  })
  // The engine routes a completion by the definition's pool, and only knows
  // the pool of definitions it has already seen. A client that has done
  // nothing else with this one would send to the default pool, where no
  // execution would ever receive it. Any lookup makes the definition known.
  return definition
    .poll(executionId)
    .pipe(Effect.andThen(DurableDeferred.done(deferred, { token, exit })))
}

/**
 * Completes a signal for one execution, waking it if it is waiting. A signal
 * sent before the workflow awaits it is stored and read when it gets there.
 *
 * The Exit is the answer the workflow receives: a value, a typed failure or a
 * defect. An Exit that holds only an interruption is none of these and is
 * refused with `SignalInterrupted` before anything is stored. Sending one
 * does not cancel the workflow; `definition.interrupt` does.
 */
export function signal<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  WSuccess extends Schema.Top,
  WError extends Schema.Top,
  Success extends Schema.Constraint,
  Error extends Schema.Constraint,
>(
  definition: Definition<Name, Fields, WSuccess, WError>,
  executionId: string,
  deferred: DurableDeferred.DurableDeferred<Success, Error>,
  exit: Exit.Exit<Success['Type'], Error['Type']>,
) {
  return Effect.gen(function* () {
    if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
      const interrupted = { executionId, signal: deferred.name }
      return yield* new SignalInterrupted(interrupted)
    }
    yield* send(definition, executionId, deferred, exit)
  })
}

/**
 * Grants a parked step its next retry budget and wakes the workflow. Results
 * of completed steps are kept; only the parked step runs again.
 */
export function retryStep<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
>(
  definition: Definition<Name, Fields, Success, Error>,
  executionId: string,
  name: string,
) {
  return Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine
    // Deferred reads are addressed through an instance; this one only names
    // the execution and never runs.
    const instance = WorkflowEngine.WorkflowInstance.initial(
      definition,
      executionId,
    )
    const read = (deferred: DurableDeferred.DurableDeferred<Schema.Void>) =>
      engine
        .deferredResult(deferred)
        .pipe(Effect.provideService(WorkflowEngine.WorkflowInstance, instance))

    let budget = 1
    while (true) {
      const parked = yield* read(parkedMarker(name, budget))
      if (Option.isNone(parked)) {
        return yield* new StepNotParked({ executionId, name })
      }

      const gate = retryGate(name, budget)
      const opened = yield* read(gate)
      if (Option.isNone(opened)) {
        yield* send(definition, executionId, gate, Exit.void)
        return budget
      }

      budget++
    }
  })
}
