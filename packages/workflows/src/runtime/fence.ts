import type { AttemptExecutor } from './executors.ts'
import type { WorkflowStore, WriteFence } from './store.ts'

export type FencedWrite = (typeof FENCED_WRITES)[number]

/** The `WorkflowStore` writes that accept a `WriteFence`. */
export const FENCED_WRITES = [
  'createNode',
  'setNodeInput',
  'selectNodeCase',
  'ensureNodeChildren',
  'ensureChildRun',
  'ensureChildAttempt',
  'createAttempt',
  'completeCurrentAttempt',
  'failCurrentAttempt',
  'timeoutCurrentAttempt',
  'completeNodeChild',
  'failNodeChild',
  'completeNode',
  'failNode',
  'waitNode',
  'markRunRunning',
  'markRunWaiting',
  'completeRun',
  'failRun',
  'requestRunCancellation',
  'cancelRun',
  'cancelNode',
  'cancelNonTerminalRunNodes',
] as const satisfies readonly (keyof WorkflowStore)[]

// These check the attempt themselves and answer a superseded one with the
// current state instead of failing: two workers recovering one failure share
// its successor, and a stale settlement is dropped rather than raised.
const CHECKS_OWN_ATTEMPT: ReadonlySet<FencedWrite> = new Set([
  'createAttempt',
  'completeCurrentAttempt',
  'failCurrentAttempt',
  'timeoutCurrentAttempt',
])

export type WriteScope = {
  readonly fence: WriteFence
  /** Runs before every fenced write, such as renewing the lease for liveness. */
  readonly before?: () => Promise<void>
}

/**
 * A fence set closer to the caller wins: a child cancellation scoped to the
 * child's lease writes under that lease, not under the parent's it runs in.
 */
function mergeFence(
  scope: WriteFence,
  own: WriteFence | undefined,
): WriteFence {
  const runLease = own?.runLease ?? scope.runLease
  const attempt = own?.attempt ?? scope.attempt
  return {
    ...(runLease === undefined ? {} : { runLease }),
    ...(attempt === undefined ? {} : { attempt }),
  }
}

export function withWriteFence(
  store: WorkflowStore,
  scope: WriteScope,
): WorkflowStore {
  const fenced: Record<string, unknown> = { ...store }
  const leaseOnly: WriteFence =
    scope.fence.runLease === undefined ? {} : { runLease: scope.fence.runLease }
  for (const name of FENCED_WRITES) {
    const fence = CHECKS_OWN_ATTEMPT.has(name) ? leaseOnly : scope.fence
    const write = store[name] as (params: {
      readonly fence?: WriteFence
    }) => Promise<unknown>
    fenced[name] = async (params: { readonly fence?: WriteFence }) => {
      await scope.before?.()
      return write({ ...params, fence: mergeFence(fence, params.fence) })
    }
  }
  return fenced as WorkflowStore
}

export function withAttemptExecutorFence(
  executor: AttemptExecutor,
  scope: WriteScope,
): AttemptExecutor {
  return {
    ...executor,
    deleteUnclaimed: async (params) => {
      await scope.before?.()
      return executor.deleteUnclaimed({
        ...params,
        fence: mergeFence(scope.fence, params.fence),
      })
    },
  }
}
