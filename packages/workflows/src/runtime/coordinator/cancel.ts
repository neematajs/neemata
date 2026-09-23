import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { RunSnapshot, StoredNodeChild, StoredRun } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { isTerminalRunStatus } from '../status.ts'
import { createRunLeaseScope } from './lease.ts'

const CHILD_CANCELLATION_LEASE_MS = 30_000

/**
 * A detached child run outlives its parent's cancellation. Only the parent's
 * edge to it is cancelled; the run itself stays cancellable by its own id.
 */
export function isDetachedChild(child: StoredNodeChild): boolean {
  return child.cancellation === 'detach'
}

export async function cancelRunTree(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
}): Promise<StoredRun | undefined> {
  const snapshot = await input.store.loadRunSnapshot(input.runId)
  if (!snapshot) return undefined
  if (isTerminalRunStatus(snapshot.run.status)) return snapshot.run

  await input.store.requestRunCancellation({ runId: input.runId })
  await input.store.cancelNonTerminalRunNodes({ runId: input.runId })

  for (const child of snapshot.children) {
    if (child.childRunId === undefined || isDetachedChild(child)) continue
    await cancelChildRun({ ...input, runId: child.childRunId })
  }

  await input.attemptExecutor.deleteUnclaimed({ runId: input.runId })
  return await input.store.cancelRun({ runId: input.runId })
}

/**
 * A child workflow has a coordinator of its own, and terminalizing the run
 * under a pass in flight lets that pass start a grandchild nobody cancels:
 * later sweeps skip the terminal child. So the child is settled only under its
 * coordination lease. When a coordinator holds it, the requested cancellation
 * and the continuation are the durable intent: that continuation settles the
 * run under its own lease, together with whatever the pass started meanwhile.
 * Task runs have no coordinator and are settled here.
 */
async function cancelChildRun(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
}): Promise<void> {
  const [run] = await input.store.loadRuns([input.runId])
  if (!run || isTerminalRunStatus(run.status)) return
  if (run.kind !== 'workflow') {
    await cancelRunTree(input)
    return
  }

  await input.store.requestRunCancellation({ runId: run.id })
  await input.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: run.id,
    workflowName: run.workflowName,
  })
  const lease = await input.store.acquireRunLease({
    runId: run.id,
    leaseMs: CHILD_CANCELLATION_LEASE_MS,
  })
  if (!lease) return
  try {
    // The child's coordinator is the competitor here, so its lease, not the
    // parent's, is what these writes must still hold.
    await cancelRunTree(
      createRunLeaseScope(input, lease, CHILD_CANCELLATION_LEASE_MS),
    )
  } finally {
    await input.store.releaseRunLease(lease)
  }
}

/**
 * For a run that fails without a coordination pass of its own: a failed run
 * must not leave children executing or nodes reporting running/waiting.
 */
export async function cancelRunDescendants(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly snapshot: RunSnapshot
}): Promise<void> {
  const runId = input.snapshot.run.id
  for (const child of input.snapshot.children) {
    if (child.childRunId === undefined || isDetachedChild(child)) continue
    await cancelChildRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: child.childRunId,
    })
  }
  await input.attemptExecutor.deleteUnclaimed({ runId })
  await input.store.cancelNonTerminalRunNodes({ runId })
}

export async function cancelNodeChildRunsAndCommands(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly runId: string
  readonly nodeName: string
}) {
  const children = await input.store.loadNodeChildren({
    runId: input.runId,
    nodeName: input.nodeName,
  })
  for (const child of children.children) {
    if (child.childRunId === undefined || isDetachedChild(child)) continue
    await cancelChildRun({
      store: input.store,
      attemptExecutor: input.attemptExecutor,
      runCoordinationExecutor: input.runCoordinationExecutor,
      runId: child.childRunId,
    })
  }
  await input.attemptExecutor.deleteUnclaimed({ runId: input.runId })
}
