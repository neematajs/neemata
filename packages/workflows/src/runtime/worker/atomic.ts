import type { ClaimedAttempt } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'

export type WorkflowRuntimeOperationContext = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
}

/**
 * Scopes an attempt's settlement to the queue claim it runs under, so a worker
 * whose claim was taken over cannot commit its result. How much is atomic is
 * the adapter's choice: PostgreSQL runs the handler in one transaction that a
 * stale `ack` rolls back; Redis and in-memory only refuse the attempt
 * settlement of a lost claim, and rely on the new claimant replaying the
 * remaining idempotent writes. Those adapters have no connection to bind, so
 * they fence the caller's `context` instead of replacing it.
 */
export type WorkflowRuntimeAtomicCompletion = {
  readonly run: <T>(
    handler: (runtime: WorkflowRuntimeOperationContext) => Promise<T>,
    claimed: ClaimedAttempt,
    context: WorkflowRuntimeOperationContext,
  ) => Promise<T>
}

export type WorkflowRuntimeAtomicContinuation = {
  readonly run: <T>(
    handler: (runtime: WorkflowRuntimeOperationContext) => Promise<T>,
  ) => Promise<T>
}

type AtomicCompletionInput = WorkflowRuntimeOperationContext & {
  readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
  readonly claimed: ClaimedAttempt
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

  return await input.atomicCompletion.run(
    (runtime) =>
      handler({
        ...input,
        store: runtime.store,
        runCoordinationExecutor: runtime.runCoordinationExecutor,
        attemptExecutor: runtime.attemptExecutor,
      }),
    input.claimed,
    input,
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
