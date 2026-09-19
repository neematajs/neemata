import type { RuntimeDeps } from '../executors.ts'

export type WorkflowRuntimeOperationContext = RuntimeDeps

/**
 * Runs a handler against a store and executors scoped to one transaction, so
 * an attempt's completion writes and its ack commit together.
 */
export type WorkflowRuntimeAtomicCompletion = {
  readonly run: <T>(
    handler: (runtime: WorkflowRuntimeOperationContext) => Promise<T>,
  ) => Promise<T>
}

/** Same contract, named apart so drivers cannot mix up the two scopes. */
export type WorkflowRuntimeAtomicContinuation = WorkflowRuntimeAtomicCompletion

export async function runAtomicCompletion<
  Input extends RuntimeDeps & {
    readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  },
  Result,
>(input: Input, handler: (scoped: Input) => Promise<Result>): Promise<Result> {
  return await runAtomic(input, input.atomicCompletion, handler)
}

export async function runAtomicContinuation<
  Input extends RuntimeDeps & {
    readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
  },
  Result,
>(input: Input, handler: (scoped: Input) => Promise<Result>): Promise<Result> {
  return await runAtomic(input, input.atomicContinuation, handler)
}

async function runAtomic<Input extends RuntimeDeps, Result>(
  input: Input,
  atomic: WorkflowRuntimeAtomicCompletion | undefined,
  handler: (scoped: Input) => Promise<Result>,
): Promise<Result> {
  if (!atomic) return await handler(input)

  return await atomic.run((runtime) => handler({ ...input, ...runtime }))
}
