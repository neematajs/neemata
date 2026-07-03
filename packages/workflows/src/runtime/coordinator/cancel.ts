import type { WorkflowImplementation } from '../../implement/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredNode, StoredRun } from '../state.ts'
import type { WorkflowStore } from '../store.ts'
import { isTerminalRunStatus } from '../status.ts'
import { getWorkflowNodeDeclaration } from './codec.ts'

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

  for (const link of snapshot.childLinks) {
    const childSnapshot = await input.store.loadRunSnapshot(link.childRunId)
    if (!childSnapshot || isTerminalRunStatus(childSnapshot.run.status))
      continue
    await input.store.requestRunCancellation({ runId: link.childRunId })
    if (childSnapshot.run.kind === 'workflow') {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: link.childRunId,
        workflowName: link.workflowName,
      })
    }
    await cancelRunTree({ ...input, runId: link.childRunId })
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
  for (const link of children.childLinks) {
    const childSnapshot = await input.store.loadRunSnapshot(link.childRunId)
    if (!childSnapshot || isTerminalRunStatus(childSnapshot.run.status))
      continue
    await input.store.requestRunCancellation({ runId: link.childRunId })
    if (childSnapshot.run.kind === 'workflow') {
      await input.runCoordinationExecutor.enqueue({
        kind: 'continueRun',
        runId: link.childRunId,
        workflowName: link.workflowName,
      })
    }
    await cancelRunTree({ ...input, runId: link.childRunId })
  }
  await input.attemptExecutor.deleteUnclaimed({ runId: input.runId })
}

export async function cancelFailedFanInNodeChildren(input: {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflow: WorkflowImplementation
  readonly runId: string
  readonly node: StoredNode
}) {
  if (!shouldCancelFailedFanInNode(input.workflow, input.node)) return
  await cancelNodeChildRunsAndCommands({
    store: input.store,
    attemptExecutor: input.attemptExecutor,
    runCoordinationExecutor: input.runCoordinationExecutor,
    runId: input.runId,
    nodeName: input.node.name,
  })
}

function shouldCancelFailedFanInNode(
  workflow: WorkflowImplementation,
  node: StoredNode,
): boolean {
  const declaration = getWorkflowNodeDeclaration(workflow, node.name)
  if (declaration.kind === 'parallel') return true
  if (declaration.kind === 'mapTask' || declaration.kind === 'mapWorkflow') {
    return declaration.mode !== 'wait-settled'
  }
  return false
}
