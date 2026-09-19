import type { RuntimeDeps } from '../executors.ts'
import type { StoredRun } from '../state.ts'
import { continueRun } from '../commands.ts'
import { isTerminalRunStatus } from '../status.ts'

export async function cancelRunTree(
  deps: RuntimeDeps,
  runId: string,
): Promise<StoredRun | undefined> {
  const snapshot = await deps.store.loadRunSnapshot(runId)
  if (!snapshot) return undefined
  if (isTerminalRunStatus(snapshot.run.status)) return snapshot.run

  await deps.store.requestRunCancellation({ runId })
  await deps.store.cancelNonTerminalRunNodes({ runId })

  for (const child of snapshot.children) {
    if (child.childRunId === undefined) continue
    const childSnapshot = await deps.store.loadRunSnapshot(child.childRunId)
    if (!childSnapshot || isTerminalRunStatus(childSnapshot.run.status))
      continue
    await deps.store.requestRunCancellation({ runId: child.childRunId })
    if (childSnapshot.run.kind === 'workflow') {
      await deps.runCoordinationExecutor.enqueue(continueRun(childSnapshot.run))
    }
    await cancelRunTree(deps, child.childRunId)
  }

  await deps.attemptExecutor.deleteUnclaimed({ runId })
  return await deps.store.cancelRun({ runId })
}
