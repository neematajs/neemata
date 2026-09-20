import type {
  NeemRuntime,
  NeemRuntimeUpstream,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem'
import type * as Layer from 'effect/Layer'
import type * as Scope from 'effect/Scope'
import { defineRuntimeWorker } from '@nmtjs/neem'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'

export type Ready = (
  upstreams?: readonly NeemRuntimeUpstream[],
) => Effect.Effect<void>

export type EffectApplication<R, EL, EM> = {
  layer: Layer.Layer<R, EL>
  /** Signal readiness after resources are listening, then keep running. */
  main: (ready: Ready) => Effect.Effect<unknown, EM, NoInfer<R> | Scope.Scope>
}

export function defineEffectWorker<R, EL, EM, Data = unknown>(
  create: (
    ctx: NeemRuntimeWorkerContext<Data, undefined>,
  ) => EffectApplication<R, EL, EM>,
): NeemRuntimeWorker<Data, undefined> {
  return defineRuntimeWorker({
    definition: undefined,
    createRuntime(ctx) {
      return createWorkerRuntime(create(ctx))
    },
  })
}

function createWorkerRuntime<R, EL, EM>(
  application: EffectApplication<R, EL, EM>,
): NeemRuntime {
  const ready = Promise.withResolvers<readonly NeemRuntimeUpstream[]>()
  const finished = Promise.withResolvers<void>()
  // Neem subscribes to finished only after start. Early failure must still be
  // observable without producing an unhandled rejection during bootstrap.
  void finished.promise.catch(() => {})

  let fiber: Fiber.Fiber<unknown, EL | EM> | undefined
  let start: Promise<readonly NeemRuntimeUpstream[]> | undefined
  let stop: Promise<void> | undefined
  let stopping = false
  let exit: Exit.Exit<unknown, EL | EM> | undefined

  function failure(result: Exit.Exit<unknown, EL | EM>): unknown {
    if (Exit.isSuccess(result))
      return new Error('Effect main completed before stop was requested')
    // A lone failure keeps its identity. Squashing several would hide the
    // finalizer defects and parallel failures that accompany it.
    return result.cause.reasons.filter(
      (reason) => !Cause.isInterruptReason(reason),
    ).length <= 1
      ? Cause.squash(result.cause)
      : new Error(Cause.pretty(result.cause), { cause: result.cause })
  }

  return {
    finished: finished.promise,
    start() {
      if (stopping) return Promise.reject(new Error('Effect worker is stopped'))
      if (start) return start

      start = ready.promise.then((upstreams) => {
        if (exit) throw failure(exit)
        if (stopping) throw new Error('Effect worker stopped before readiness')
        return upstreams
      })
      const signal: Ready = (upstreams = []) =>
        Effect.sync(() => {
          if (!stopping) ready.resolve(upstreams)
        })

      // The layer and main share the supervised lifetime. The fiber's Exit is
      // observed only after both application and service finalizers have run.
      fiber = Effect.runFork(
        Effect.scoped(Effect.suspend(() => application.main(signal))).pipe(
          Effect.provide(application.layer),
        ),
      )
      fiber.addObserver((result) => {
        exit = result
        if (!stopping) {
          const error = failure(result)
          ready.reject(error)
          finished.reject(error)
        } else {
          ready.reject(new Error('Effect worker stopped before readiness'))
          if (
            Exit.isFailure(result) &&
            !Cause.hasInterruptsOnly(result.cause)
          ) {
            finished.reject(failure(result))
          } else {
            finished.resolve()
          }
        }
      })
      return start
    },
    stop() {
      if (stop) return stop
      stopping = true
      if (!fiber || exit) {
        if (!fiber) finished.resolve()
        return (stop = Promise.resolve())
      }
      const running = fiber
      stop = Effect.runPromise(Fiber.interrupt(running)).then(
        () => finished.promise,
      )
      return stop
    },
  }
}
