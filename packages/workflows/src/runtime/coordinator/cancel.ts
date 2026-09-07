import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredRun } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { isTerminalRunStatus } from '../status.ts'

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
    if (child.childRunId === undefined) continue
    const childSnapshot = await input.store.loadRunSnapshot(child.childRunId)
    if (!childSnapshot || isTerminalRunStatus(childSnapshot.run.status))
      continue
    await input.store.requestRunCancellation({ runId: child.childRunId })
    if (childSnapshot.run.kind === 'workflow') {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRunId,
        workflowName: childSnapshot.run.workflowName,
      })
    }
    await cancelRunTree({ ...input, runId: child.childRunId })
  }

  await input.attemptExecutor.deleteUnclaimed({ runId: input.runId })
  return await input.store.cancelRun({ runId: input.runId })
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
    if (child.childRunId === undefined) continue
    const childSnapshot = await input.store.loadRunSnapshot(child.childRunId)
    if (!childSnapshot || isTerminalRunStatus(childSnapshot.run.status))
      continue
    await input.store.requestRunCancellation({ runId: child.childRunId })
    if (childSnapshot.run.kind === 'workflow') {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: child.childRunId,
        workflowName: childSnapshot.run.workflowName,
      })
    }
    await cancelRunTree({ ...input, runId: child.childRunId })
  }
  await input.attemptExecutor.deleteUnclaimed({ runId: input.runId })
}
