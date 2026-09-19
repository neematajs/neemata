import type { RuntimeDeps } from './executors.ts'
import type { StoredRun } from './state.ts'
import { continueRun } from './commands.ts'

export async function wakeParentRun(
  deps: Pick<RuntimeDeps, 'store' | 'runCoordinationExecutor'>,
  run: Pick<StoredRun, 'parentRunId' | 'parentNodeName'> | undefined,
) {
  if (!run?.parentRunId || !run.parentNodeName) return

  const [parent] = await deps.store.loadRuns([run.parentRunId])
  if (!parent) return

  await deps.runCoordinationExecutor.enqueue(continueRun(parent))
}
