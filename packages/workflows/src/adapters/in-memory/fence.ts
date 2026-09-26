import type { AttemptExecutor } from '../../runtime/executors.ts'
import type { WorkflowStore, WriteFence } from '../../runtime/store.ts'
import type { State } from './state.ts'
import { StaleWriteFenceError } from '../../runtime/errors.ts'
import { FENCED_WRITES } from '../../runtime/fence.ts'
import { childKey } from './records.ts'

function assertWriteFence(state: State, fence: WriteFence | undefined) {
  if (fence?.runLease) {
    const lease = state.runLeases.get(fence.runLease.runId)
    if (
      lease?.leaseToken !== fence.runLease.leaseToken ||
      lease.expiresAt <= state.now()
    ) {
      throw new StaleWriteFenceError()
    }
  }
  if (fence?.attempt) {
    const { runId, nodeName, childKey: key, attemptId } = fence.attempt
    const child = state.children.get(childKey(runId, nodeName, key))
    if (child?.currentAttemptId !== attemptId) throw new StaleWriteFenceError()
  }
}

type FencedParams = { readonly fence?: WriteFence }

// Writes are synchronous up to their first await, so a check made in the same
// tick, right before calling one, is atomic with it.
function guard<Params extends FencedParams, Result>(
  state: State,
  write: (params: Params) => Promise<Result>,
): (params: Params) => Promise<Result> {
  return async (params) => {
    assertWriteFence(state, params.fence)
    return write(params)
  }
}

export function fenceStoreWrites<Store extends Partial<WorkflowStore>>(
  state: State,
  store: Store,
): Store {
  const fenced: Record<string, unknown> = { ...store }
  for (const name of FENCED_WRITES) {
    const write = store[name] as
      | ((params: FencedParams) => Promise<unknown>)
      | undefined
    if (write) fenced[name] = guard(state, write)
  }
  return fenced as Store
}

export function fenceDeleteUnclaimed(
  state: State,
  executor: AttemptExecutor,
): AttemptExecutor {
  return {
    ...executor,
    deleteUnclaimed: guard(state, (params) => executor.deleteUnclaimed(params)),
  }
}
