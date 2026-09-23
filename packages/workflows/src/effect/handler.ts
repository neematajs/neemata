import type * as Context from 'effect/Context'
import type * as Scope from 'effect/Scope'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

/** Retain mixed failures and finalizer defects instead of squashing their Cause. */
export class WorkflowHandlerError extends Error {
  declare readonly cause: Cause.Cause<unknown>

  constructor(cause: Cause.Cause<unknown>) {
    super(Cause.pretty(cause), { cause })
    this.name = 'WorkflowHandlerError'
  }
}

/**
 * The env of Effect handlers: it runs each one with the worker's services.
 *
 * `run` is a function-typed property so its handler parameter stays
 * contravariant: a runtime is only assignable where it provides at least the
 * services required there. Method syntax would compare bivariantly and let a
 * runtime built from an insufficient context through.
 */
export type HandlerRuntime<R = never> = {
  readonly run: <A>(
    handler: () => Effect.Effect<A, unknown, R | Scope.Scope>,
    signal: AbortSignal,
  ) => Promise<A>
}

export function createHandlerRuntime<R>(
  context: Context.Context<R>,
): HandlerRuntime<R> {
  return {
    async run(handler, signal) {
      // These entry-point fibers share services, not the main fiber's lifetime.
      // The promise settles after the handler's scope has closed, so the engine's
      // cleanup deadline covers finalizers as well.
      const exit = await Effect.runPromiseExitWith(context)(
        Effect.scoped(Effect.suspend(handler)),
        { signal },
      )
      if (Exit.isSuccess(exit)) return exit.value
      if (Cause.hasInterruptsOnly(exit.cause) && signal.aborted)
        throw signal.reason
      if (exit.cause.reasons.length === 1) {
        const reason = exit.cause.reasons[0]!
        // Preserve the existing StoredError representation for ordinary errors.
        if (Cause.isFailReason(reason)) throw reason.error
        if (Cause.isDieReason(reason)) throw reason.defect
      }
      throw new WorkflowHandlerError(exit.cause)
    },
  }
}
