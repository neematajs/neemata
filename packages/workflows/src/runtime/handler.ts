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

export class WorkflowCleanupTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Workflow cleanup exceeded ${timeoutMs}ms; worker recycling required`)
    this.name = 'WorkflowCleanupTimeoutError'
  }
}

export type HandlerRuntimeOptions = {
  readonly cleanupTimeoutMs?: number
  readonly onFatal?: (error: unknown) => void
}

/**
 * `run` is a function-typed property so its handler parameter stays
 * contravariant: a runtime is only assignable where it provides at least the
 * services required there. Method syntax would compare bivariantly and let a
 * runtime built from an insufficient context through.
 *
 * The default is the erased form every runtime is assignable to. The engine uses
 * it below the typed entry points, where the durable registry has already erased
 * the heterogeneous requirements of its handlers.
 */
export type HandlerRuntime<R = never> = {
  readonly run: <A>(
    handler: () => Effect.Effect<A, unknown, R | Scope.Scope>,
    signal?: AbortSignal,
  ) => Promise<A>
  readonly drain: () => Promise<void>
}

export function createHandlerRuntime<R>(
  context: Context.Context<R>,
  options: HandlerRuntimeOptions = {},
): HandlerRuntime<R> {
  const timeoutMs = options.cleanupTimeoutMs ?? 5_000
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error(
      'Workflow cleanupTimeoutMs must be a finite non-negative number',
    )
  }
  const pending = new Set<Promise<unknown>>()
  return {
    async run(handler, signal) {
      // Do not enter user code for an attempt that has already lost ownership.
      if (signal?.aborted) throw signal.reason
      // These entry-point fibers share services, not the main fiber's lifetime.
      const work = Effect.runPromiseExitWith(context)(
        Effect.scoped(Effect.suspend(handler)),
        { signal },
      )
      pending.add(work)
      void work.finally(() => pending.delete(work))
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      const overrun = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          timer = setTimeout(() => {
            const error = new WorkflowCleanupTimeoutError(timeoutMs)
            reject(error)
            options.onFatal?.(error)
          }, timeoutMs)
        }
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
      })
      try {
        const exit = await Promise.race([work, overrun])
        if (Exit.isSuccess(exit)) return exit.value
        if (Cause.hasInterruptsOnly(exit.cause) && signal?.aborted)
          throw signal.reason
        if (exit.cause.reasons.length === 1) {
          const reason = exit.cause.reasons[0]!
          // Preserve the existing StoredError representation for ordinary errors.
          if (Cause.isFailReason(reason)) throw reason.error
          if (Cause.isDieReason(reason)) throw reason.defect
        }
        throw new WorkflowHandlerError(exit.cause)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
    },
    async drain() {
      // Overrun is reported separately; it never authorizes disposing shared
      // Layer services while an uninterruptible handler still uses them.
      while (pending.size > 0) await Promise.allSettled(pending)
    },
  }
}
