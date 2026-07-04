import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'

export type WorkflowRuntimeOperationContext = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
}

export type WorkflowRuntimeAtomicCompletion = {
  readonly run: <T>(
    handler: (runtime: WorkflowRuntimeOperationContext) => Promise<T>,
  ) => Promise<T>
}

export type WorkflowRuntimeAtomicContinuation = {
  readonly run: <T>(
    handler: (runtime: WorkflowRuntimeOperationContext) => Promise<T>,
  ) => Promise<T>
}

type AtomicCompletionInput = WorkflowRuntimeOperationContext & {
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
}

type AtomicContinuationInput = WorkflowRuntimeOperationContext & {
  readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
}

export async function runAtomicCompletion<
  Input extends AtomicCompletionInput,
  Result,
>(
  input: Input,
  handler: (scopedInput: Input) => Promise<Result>,
): Promise<Result> {
  if (!input.atomicCompletion) return await handler(input)

  return await input.atomicCompletion.run((runtime) =>
    handler({
      ...input,
      store: runtime.store,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      attemptExecutor: runtime.attemptExecutor,
    }),
  )
}

export async function runAtomicContinuation<
  Input extends AtomicContinuationInput,
  Result,
>(
  input: Input,
  handler: (runtime: WorkflowRuntimeOperationContext) => Promise<Result>,
): Promise<Result> {
  if (!input.atomicContinuation) {
    return await handler({
      store: input.store,
      runCoordinationExecutor: input.runCoordinationExecutor,
      attemptExecutor: input.attemptExecutor,
    })
  }

  return await input.atomicContinuation.run(handler)
}
