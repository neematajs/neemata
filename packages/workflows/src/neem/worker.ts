import type { NeemRuntimeWorkerContext } from '@nmtjs/neem'
import { defineEffectWorker } from '@nmtjs/effect/neem/worker'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'

import type { Services } from '../dsl/declaration.ts'
import type { AnySchedule } from '../dsl/schedule.ts'
import type { AnyTask } from '../dsl/task.ts'
import type { ServedWorkflow } from '../dsl/workflow.ts'
import type { Store } from '../store.ts'
import type { Served } from '../worker/index.ts'
import type { WorkerData } from './plan.ts'
import { CleanupTimeout } from '../errors.ts'
import { coordinator, execution, verify } from '../worker/index.ts'
import { logging } from './logger.ts'

/** `data` names the thread's role and pool; `logger` is the worker's logger. */
export type WorkerContext = NeemRuntimeWorkerContext<WorkerData, undefined>

/**
 * What `layer` is to provide: `store` already provides the store, and each
 * handler is given the scope of its attempt.
 */
type Provided<D> = Exclude<Services<D>, Store | Scope.Scope>

/**
 * Everything the deployment serves, the store its threads share, and the
 * services its handlers require. Every thread is given the same definition
 * and takes from it what its role and pool run.
 */
export type WorkflowsWorker<
  W extends ServedWorkflow = ServedWorkflow,
  T extends AnyTask = AnyTask,
> = Served<W, T> & {
  /**
   * The schedules of the deployment, all of them: a coordinator makes the
   * stored schedules these as it starts, removes any other, and fires those
   * that are due. Omitted, schedules are left alone.
   */
  readonly schedules?: readonly AnySchedule[]
  /**
   * The store of the thread, built when it starts and released when it has
   * stopped. Threads share runs only through a durable store: an in-memory
   * one is a thread's own.
   */
  readonly store: (ctx: WorkerContext) => Layer.Layer<Store, unknown>
} & ([Provided<W | T>] extends [never]
    ? { readonly layer?: (ctx: WorkerContext) => HandlerLayer<never> }
    : { readonly layer: (ctx: WorkerContext) => HandlerLayer<Provided<W | T>> })

/**
 * The services of the handlers, built in the threads that run handlers and
 * released once those have ended. It may use the store, as handlers may.
 */
type HandlerLayer<R> = Layer.Layer<R, unknown, Store>

/**
 * A handler that outlived its cleanup is still running and may still use the
 * thread's services, so those are not released under it: the thread fails as
 * it is and Neem replaces it.
 */
const abandoned = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) && reason.error instanceof CleanupTimeout,
  )

/** The worker of a thread's role. Throws for what must not start. */
function serve(
  {
    workflows = [],
    tasks = [],
    schedules,
  }: Served & Pick<WorkflowsWorker, 'schedules'>,
  data: WorkerData,
): Effect.Effect<never, unknown, unknown> {
  // One declaration may arrive through several module lists.
  const served = {
    workflows: Array.from(new Set(workflows)),
    tasks: Array.from(new Set(tasks)),
  }
  verify({
    ...served,
    ...(schedules === undefined ? {} : { schedules }),
    pools: data.pools,
  })

  switch (data.role) {
    case 'coordinator':
      return coordinator({
        ...data.options,
        workflows: served.workflows,
        ...(schedules === undefined ? {} : { schedules }),
      })
    case 'execution':
      return execution({ ...data.options, ...served, pool: data.pool })
    default:
      throw new Error(
        'Workflows worker has no role: its runtime needs a planner made with defineWorkflowsPlanner',
      )
  }
}

/**
 * A Neem worker thread that is a coordinator or the execution worker of one
 * pool, as its planner decided. It starts only if what is served is complete
 * and names planned pools, and its options are valid; nothing is acquired
 * before that is known.
 *
 * Stopping interrupts the handlers, gives their commands back and then
 * releases the layers; Neem's stop deadline bounds all of it.
 */
export function defineWorkflowsWorker<
  const W extends ServedWorkflow = never,
  const T extends AnyTask = never,
>(definition: WorkflowsWorker<W, T>) {
  return defineEffectWorker((ctx: WorkerContext) => ({
    // Around everything the thread runs, the building of its layers included.
    layer: logging(ctx.logger),
    main: (ready) =>
      Effect.suspend(() => {
        const worker = serve(definition, ctx.data)
        const store = definition.store(ctx)
        // A coordinator runs no handler.
        const services =
          ctx.data.role === 'execution' && definition.layer
            ? Layer.provideMerge(definition.layer(ctx), store)
            : store

        // Not the preset's scope, which is closed whatever the exit.
        return Effect.acquireUseRelease(
          Scope.make(),
          (scope) =>
            Effect.flatMap(Layer.buildWithScope(services, scope), (context) =>
              Effect.andThen(
                ready(),
                // The definition's type is what proves the layers provide
                // what the handlers require: the worker's own is erased.
                Effect.provide(
                  worker as Effect.Effect<never, unknown>,
                  context,
                ),
              ),
            ),
          (scope, exit) =>
            abandoned(exit) ? Effect.void : Scope.close(scope, exit),
        )
      }),
  }))
}
