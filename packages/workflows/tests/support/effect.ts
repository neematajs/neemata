import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

import type {
  RunExecutionWorkerInput,
  RunWorkflowWorkerInput,
  WorkerLoopResult,
} from '../../src/runtime/index.ts'
import { createHandlerRuntime } from '../../src/effect/index.ts'
import {
  runExecutionWorker as runStoredExecutionWorker,
  runWorkflowWorker as runStoredWorkflowWorker,
  serveExecutionWorker as serveStoredExecutionWorker,
  serveWorkflowWorker as serveStoredWorkflowWorker,
} from '../../src/runtime/index.ts'

/** Existing engine scenarios use async bodies; the runtime sees only Effects. */
export const fromPromise = <A>(handler: () => A | Promise<A>) =>
  Effect.promise(() => Promise.resolve(handler()))

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown
  ? Omit<T, Key>
  : never

// Engine scenarios drive the core loops as Promises, with Effect handlers run
// from an explicit context, so they can await, abort and inspect each loop.
type WithContext<Input, R> = DistributiveOmit<Input, 'env'> & {
  readonly context: Context.Context<R>
}

type Serving = { readonly signal: AbortSignal }

export const runWorkflowWorker = <R>({
  context,
  ...input
}: WithContext<RunWorkflowWorkerInput, R>): Promise<WorkerLoopResult> =>
  runStoredWorkflowWorker({ ...input, env: createHandlerRuntime(context) })

export const serveWorkflowWorker = <R>({
  context,
  ...input
}: WithContext<RunWorkflowWorkerInput, R> &
  Serving): Promise<WorkerLoopResult> =>
  serveStoredWorkflowWorker({ ...input, env: createHandlerRuntime(context) })

export const runExecutionWorker = <R>({
  context,
  ...input
}: WithContext<RunExecutionWorkerInput, R>): Promise<WorkerLoopResult> =>
  runStoredExecutionWorker({ ...input, env: createHandlerRuntime(context) })

export const serveExecutionWorker = <R>({
  context,
  ...input
}: WithContext<RunExecutionWorkerInput, R> &
  Serving): Promise<WorkerLoopResult> =>
  serveStoredExecutionWorker({ ...input, env: createHandlerRuntime(context) })
