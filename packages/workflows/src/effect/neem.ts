import type * as Scope from 'effect/Scope'
import { createFuture } from '@nmtjs/common'
import { defineRuntimeWorker } from '@nmtjs/neem'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'

import type {
  AnyTaskImplementation,
  AnyWorkflowsConfig,
  AnyWorkflowImplementation,
  WorkflowsConfig,
  WorkflowsWorkerData,
} from '../neem/runtime.ts'
import type { WorkflowRuntimeAdapter } from '../runtime/client.ts'
import type { AnyScheduleDefinition } from '../types/index.ts'
import type { Requirements } from './implement.ts'
import { resolveWorkflowsConfig } from '../neem/runtime.ts'
import { resolveExecutionWorkerPool, runRoleLoop } from '../neem/serve.ts'
import {
  createHandlerRunner,
  WorkflowCleanupTimeoutError,
} from '../runtime/handler.ts'
import { createHandlerRuntime } from './handler.ts'

export type WorkflowsRuntime<R = never> = Effect.Effect<
  WorkflowRuntimeAdapter,
  unknown,
  R | Scope.Scope
>

/** The services of one worker thread: the adapter and what handlers require. */
export type WorkflowsWorkerServices<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
  T extends AnyTaskImplementation = AnyTaskImplementation,
  R = never,
> = { readonly runtime: WorkflowsRuntime<R> } & WorkflowServices<
  Requirements<W | T> | R
>

type WorkflowServices<R> = [Exclude<R, Scope.Scope>] extends [never]
  ? { readonly layer?: Layer.Layer<never, unknown> }
  : { readonly layer: Layer.Layer<Exclude<R, Scope.Scope>, unknown> }

export function defineWorkflowsWorker<
  W extends AnyWorkflowImplementation,
  T extends AnyTaskImplementation,
  R = never,
>(
  definition: WorkflowsConfig<W, T, AnyScheduleDefinition>,
  services: NoInfer<WorkflowsWorkerServices<W, T, R>> & {
    readonly runtime: WorkflowsRuntime<R>
  },
) {
  return defineRuntimeWorker<WorkflowsWorkerData, AnyWorkflowsConfig>({
    definition,
    createRuntime(ctx) {
      const abort = new AbortController()
      const ready = createFuture<undefined>()
      const finished = createFuture<void>()
      void ready.promise.catch(() => {})
      void finished.promise.catch(() => {})
      let fiber: Fiber.Fiber<void, unknown> | undefined
      let start: Promise<undefined> | undefined
      let stopping = false
      let stop: Promise<void> | undefined
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined
      const fatal = (error: unknown) => {
        // finished is observed by Neem before scope cleanup completes. An overrun
        // requires thread recycling, not disposal of services still in use.
        abort.abort(error)
        finished.reject(error)
      }
      // Workflow supervision deliberately lives here: it needs the worker
      // definition and can report fatal overruns before scoped cleanup finishes.
      async function initialize() {
        const config = await resolveWorkflowsConfig(ctx.definition)
        if (stopping) throw new Error('Workflows worker stopped')
        const pool =
          ctx.data.role === 'execution'
            ? resolveExecutionWorkerPool(config, ctx.data)
            : undefined
        const timeoutMs =
          pool?.cleanupTimeoutMs ?? config.workers.coordinator.cleanupTimeoutMs
        const main = Effect.gen(function* () {
          const context = yield* Effect.context<any>()
          const env = createHandlerRuntime(context)
          const handlers = createHandlerRunner({
            cleanupTimeoutMs: timeoutMs,
            onFatal: fatal,
          })
          const runtime = yield* Effect.acquireRelease(
            services.runtime as WorkflowsRuntime<any>,
            (runtime) =>
              Effect.promise(async () => {
                await runtime.dispose?.()
              }),
          )
          if (ctx.data.role === 'coordinator' && config.schedules.length > 0) {
            if (!runtime.scheduler)
              return yield* Effect.die(
                new Error(
                  'Workflow runtime adapter does not support schedules',
                ),
              )
            yield* Effect.promise(() =>
              runtime.scheduler!.reconcile(config.schedules),
            )
          }
          const loop = runRoleLoop({
            data: ctx.data,
            runtime,
            config,
            executionPool: pool,
            handlers,
            env,
            workerId: ctx.name,
            signal: abort.signal,
            onError: (error) =>
              ctx.logger.error({ err: error }, 'Neem workflows worker error'),
          })
          void loop.catch(() => {})
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              abort.abort()
              // Keep the deadline armed through adapter and Layer finalizers,
              // so a failed worker cannot hang in cleanup while appearing live.
              cleanupTimer = setTimeout(
                () => fatal(new WorkflowCleanupTimeoutError(timeoutMs)),
                timeoutMs,
              )
              // Stop claims and abort attempts, then join engine work before
              // draining handlers: an execution awaiting storage may register one.
              await loop.catch(() => {})
              await handlers.drain()
            }),
          )
          ready.resolve(undefined)
          yield* Effect.promise(() => loop)
        })
        // The typed services check coverage; the registry erases the distinct
        // requirements of its handlers and adapter factory here.
        const layer = (services.layer ?? Layer.empty) as Layer.Layer<
          any,
          unknown
        >
        fiber = Effect.runFork(Effect.scoped(main).pipe(Effect.provide(layer)))
        fiber.addObserver((exit) => {
          if (cleanupTimer !== undefined) clearTimeout(cleanupTimer)
          if (
            Exit.isFailure(exit) &&
            !(stopping && Cause.hasInterruptsOnly(exit.cause))
          ) {
            // A lone failure keeps its identity; several keep their rendering.
            const error =
              exit.cause.reasons.filter(
                (reason) => !Cause.isInterruptReason(reason),
              ).length <= 1
                ? Cause.squash(exit.cause)
                : new Error(Cause.pretty(exit.cause), { cause: exit.cause })
            ctx.logger.error(
              { err: error },
              'Neem workflows worker loop failed',
            )
            ready.reject(error)
            finished.reject(error)
          } else if (!stopping) {
            const error = new Error(
              'Workflows worker finished before stop was requested',
            )
            ready.reject(error)
            finished.reject(error)
          } else {
            ready.reject(new Error('Workflows worker stopped before readiness'))
            finished.resolve()
          }
        })
      }
      return {
        finished: finished.promise,
        start() {
          if (stopping)
            return Promise.reject(new Error('Workflows worker stopped'))
          if (start) return start
          // Memoize before asynchronous definition resolution can yield.
          start = ready.promise
          void initialize().catch((error: unknown) => {
            ready.reject(error)
            finished.reject(error)
          })
          return start
        },
        stop() {
          if (stop) return stop
          stopping = true
          abort.abort()
          if (!fiber) {
            ready.reject(new Error('Workflows worker stopped before readiness'))
            finished.resolve()
            return (stop = Promise.resolve())
          }
          stop = Effect.runPromise(Fiber.interrupt(fiber)).then(
            () => finished.promise,
          )
          return stop
        },
      }
    },
  })
}
