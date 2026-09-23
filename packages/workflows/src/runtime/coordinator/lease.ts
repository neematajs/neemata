import type { AttemptExecutor } from '../executors.ts'
import type { RunLease, WorkflowStore } from '../store.ts'
import { StaleWriteFenceError } from '../errors.ts'
import { withAttemptExecutorFence, withWriteFence } from '../fence.ts'
import { isTerminalRunStatus } from '../status.ts'

export class StaleRunLeaseError extends Error {
  constructor() {
    super('Stale workflow run lease')
    this.name = 'StaleRunLeaseError'
  }
}

export class CancelledRunError extends Error {
  constructor() {
    super('Workflow run cancellation observed during coordination')
    this.name = 'CancelledRunError'
  }
}

/**
 * Scopes coordination writes to a run lease. Each write renews the lease so
 * the holder stays live, and carries it as a `WriteFence` so the adapter
 * refuses the write atomically once another holder took the lease over.
 */
export function createRunLeaseScope<
  Context extends {
    readonly store: WorkflowStore
    readonly attemptExecutor: AttemptExecutor
  },
>(
  context: Context,
  lease: RunLease,
  leaseMs: number,
  signal?: AbortSignal,
): Context {
  const { store } = context
  const scope = {
    fence: { runLease: lease },
    before: async () => {
      signal?.throwIfAborted()
      const renewedLease = await store.renewRunLease(lease, leaseMs)
      if (!renewedLease) throw new StaleRunLeaseError()
      signal?.throwIfAborted()
    },
  }
  const fenced = withWriteFence(store, scope)
  return {
    ...context,
    store: {
      ...fenced,
      ensureChildRun: async (params) => {
        // Renewal only observes a cancellation on its next tick; a child run
        // started in between would execute until the cancelling pass finds it.
        const [run] = await store.loadRuns([lease.runId])
        if (
          run &&
          (run.status === 'cancelling' || isTerminalRunStatus(run.status))
        ) {
          throw new CancelledRunError()
        }
        return fenced.ensureChildRun(params)
      },
    },
    attemptExecutor: withAttemptExecutorFence(context.attemptExecutor, scope),
  }
}

/** The pass or sweep lost its run lease; another holder carries on. */
export function isRunLeaseLost(error: unknown): boolean {
  return (
    error instanceof StaleRunLeaseError ||
    error instanceof CancelledRunError ||
    error instanceof StaleWriteFenceError
  )
}
