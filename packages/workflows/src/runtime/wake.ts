import type { RunCoordinationExecutor } from './executors.ts'
import type { StoredRun } from './state.ts'
import type { WorkflowStore } from './store.ts'
import { continueRunCommand } from './commands.ts'

export async function wakeParentRun(input: {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly run: Pick<StoredRun, 'parentRunId' | 'parentNodeName'> | undefined
}) {
  if (!input.run?.parentRunId || !input.run.parentNodeName) return

  const parent = await input.store.loadRunSnapshot(input.run.parentRunId)
  if (!parent) return

  await input.runCoordinationExecutor.enqueue(continueRunCommand(parent.run))
}
