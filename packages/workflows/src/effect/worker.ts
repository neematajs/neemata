import type * as Context from 'effect/Context'
import type * as Scope from 'effect/Scope'

import type {
  TaskImplementation,
  WorkflowImplementation,
} from '../implement/index.ts'
import type {
  RunExecutionWorkerInput as StoredExecutionWorkerInput,
  RunWorkflowWorkerInput as StoredWorkflowWorkerInput,
  WorkerLoopResult,
} from '../runtime/worker.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
} from '../types/index.ts'
import type { Requirements } from './implement.ts'
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

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown
  ? Omit<T, Key>
  : never

// Lists in the erased form carry no requirement, so any context serves them.
type Services<T> = 0 extends 1 & Requirements<T>
  ? never
  : Exclude<Requirements<T>, Scope.Scope>

/** The worker supplies the services its handlers require as their env. */
type WithContext<Input, T> = DistributiveOmit<Input, 'env'> & {
  readonly context: Context.Context<Services<T>>
}

export type RunWorkflowWorkerInput<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
> = WithContext<StoredWorkflowWorkerInput<W>, W>

export type RunExecutionWorkerInput<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
  T extends AnyTaskImplementation = AnyTaskImplementation,
> = WithContext<StoredExecutionWorkerInput<W, T>, W | T>

export function runWorkflowWorker<W extends AnyWorkflowImplementation>(
  input: RunWorkflowWorkerInput<W>,
): Promise<WorkerLoopResult> {
  return runStoredWorkflowWorker<any>({
    ...input,
    env: createHandlerRuntime(input.context),
  })
}

export function serveWorkflowWorker<W extends AnyWorkflowImplementation>(
  input: RunWorkflowWorkerInput<W> & { readonly signal: AbortSignal },
): Promise<WorkerLoopResult> {
  return serveStoredWorkflowWorker<any>({
    ...input,
    env: createHandlerRuntime(input.context),
  })
}

export function runExecutionWorker<
  W extends AnyWorkflowImplementation,
  T extends AnyTaskImplementation,
>(input: RunExecutionWorkerInput<W, T>): Promise<WorkerLoopResult> {
  return runStoredExecutionWorker<any, any>({
    ...input,
    env: createHandlerRuntime(input.context),
  })
}

export function serveExecutionWorker<
  W extends AnyWorkflowImplementation,
  T extends AnyTaskImplementation,
>(
  input: RunExecutionWorkerInput<W, T> & { readonly signal: AbortSignal },
): Promise<WorkerLoopResult> {
  return serveStoredExecutionWorker<any, any>({
    ...input,
    env: createHandlerRuntime(input.context),
  })
}
