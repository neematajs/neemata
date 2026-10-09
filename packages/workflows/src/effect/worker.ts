import type * as Context from 'effect/Context'
import type * as Scope from 'effect/Scope'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type { HandlerRunner, HandlerRunnerOptions } from '../runtime/handler.ts'
import type {
  RunExecutionWorkerInput as StoredExecutionWorkerInput,
  RunWorkflowWorkerInput as StoredWorkflowWorkerInput,
  WorkerLoopResult,
} from '../runtime/worker.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
} from '../types/index.ts'
import type { HandlerRuntime } from './handler.ts'
import type { Requirements } from './implement.ts'
import { createHandlerRunner } from '../runtime/handler.ts'
import {
  runExecutionWorker as runStoredExecutionWorker,
  runWorkflowWorker as runStoredWorkflowWorker,
  serveExecutionWorker as serveStoredExecutionWorker,
  serveWorkflowWorker as serveStoredWorkflowWorker,
} from '../runtime/worker.ts'
import { createHandlerRuntime } from './handler.ts'

type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>
type AnyTaskImplementation = TaskImplementation<AnyTaskDefinition, any>

// Lists in the erased form carry no requirement, so any context serves them.
type Services<T> = 0 extends 1 & Requirements<T>
  ? never
  : Exclude<Requirements<T>, Scope.Scope>

/**
 * The Effect owns what the core worker takes as options: handlers get their
 * services from its context, engine errors go to its logger, interruption
 * stops the loop, and it drains its own handlers before completing.
 */
type EffectWorkerInput<Input> = Omit<
  Input,
  'env' | 'handlers' | 'onError' | 'signal'
> &
  HandlerRunnerOptions

export type RunWorkflowWorkerInput<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
> = EffectWorkerInput<StoredWorkflowWorkerInput<W>>

export type RunExecutionWorkerInput<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
  T extends AnyTaskImplementation = AnyTaskImplementation,
> = EffectWorkerInput<StoredExecutionWorkerInput<W, T>>

type LoopInput = {
  readonly env: HandlerRuntime<any>
  readonly handlers: HandlerRunner
  readonly onError: (error: unknown) => void
  readonly signal: AbortSignal
}

/**
 * Drains the work claimable now and succeeds with the number of commands
 * processed. Interruption stops claiming, aborts running handlers and waits for
 * them before it completes.
 */
export function runWorkflowWorker<W extends AnyWorkflowImplementation>(
  input: RunWorkflowWorkerInput<W>,
): Effect.Effect<WorkerLoopResult, never, Services<W>> {
  return runLoop(input, (loop) =>
    runStoredWorkflowWorker<any>({ ...input, ...loop }),
  )
}

/**
 * Serves workflow coordination until interrupted, so it can be the main
 * program under `NodeRuntime.runMain`. Interruption stops claiming, aborts
 * running handlers and waits for them before the services they use are
 * released. It dies only when the adapter itself fails.
 */
export function serveWorkflowWorker<W extends AnyWorkflowImplementation>(
  input: RunWorkflowWorkerInput<W>,
): Effect.Effect<never, never, Services<W>> {
  return serveLoop(
    runLoop(input, (loop) =>
      serveStoredWorkflowWorker<any>({ ...input, ...loop }),
    ),
  )
}

/** The execution counterpart of `runWorkflowWorker`. */
export function runExecutionWorker<
  W extends AnyWorkflowImplementation,
  T extends AnyTaskImplementation,
>(
  input: RunExecutionWorkerInput<W, T>,
): Effect.Effect<WorkerLoopResult, never, Services<W | T>> {
  return runLoop(input, (loop) =>
    runStoredExecutionWorker<any, any>({ ...input, ...loop }),
  )
}

/** The execution counterpart of `serveWorkflowWorker`. */
export function serveExecutionWorker<
  W extends AnyWorkflowImplementation,
  T extends AnyTaskImplementation,
>(
  input: RunExecutionWorkerInput<W, T>,
): Effect.Effect<never, never, Services<W | T>> {
  return serveLoop(
    runLoop(input, (loop) =>
      serveStoredExecutionWorker<any, any>({ ...input, ...loop }),
    ),
  )
}

function runLoop<R>(
  options: HandlerRunnerOptions,
  start: (input: LoopInput) => Promise<WorkerLoopResult>,
): Effect.Effect<WorkerLoopResult, never, R> {
  return Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const handlers = createHandlerRunner(options)
    // Through the context's logger, so an application's Logger.layer receives
    // engine errors along with its own logs. A throwing logger must not reject
    // the engine's reporting path.
    const onError = (error: unknown) => reportError(context, error)
    const loop = Effect.callback<WorkerLoopResult>((resume) => {
      const abort = new AbortController()
      const settled = start({
        env: createHandlerRuntime(context),
        handlers,
        onError,
        signal: abort.signal,
      })
      settled.then(
        (result) => resume(Effect.succeed(result)),
        (error: unknown) => resume(Effect.die(error)),
      )
      // Interruption completes only once the loop has stopped claiming and
      // joined the executions it started.
      return Effect.promise(() => {
        abort.abort()
        return settled.then(noop, noop)
      })
    })
    // A handler that outlives its cleanup deadline fails the loop, but its
    // services must stay available until it returns.
    return yield* Effect.ensuring(
      loop,
      Effect.promise(() => handlers.drain()),
    )
  })
}

// A serving loop returns only after its signal is aborted, which happens only
// when this Effect is interrupted, so it never succeeds.
function serveLoop<R>(
  loop: Effect.Effect<WorkerLoopResult, never, R>,
): Effect.Effect<never, never, R> {
  return Effect.andThen(loop, Effect.never)
}

function reportError<R>(context: Context.Context<R>, error: unknown) {
  try {
    Effect.runSyncWith(context)(
      Effect.logError('Workflow worker error', Cause.die(error)),
    )
  } catch {
    console.error('Workflow worker error', error)
  }
}

const noop = () => {}
