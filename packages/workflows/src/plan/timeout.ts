import type { StoredRun } from '../model.ts'
import type { AnyWorkflowProgram } from '../program.ts'
import type { Plan, ReadScope } from '../store.ts'
import { isTerminal, parseDurationMs } from '../model.ts'
import { drift, revisionKey } from './definitions.ts'
import { planning } from './draft.ts'
import { failRun } from './finish.ts'

export function timeoutScope(
  program: AnyWorkflowProgram,
  runId: string,
): ReadScope {
  const { name, revision } = program
  return {
    runs: [runId],
    definitions:
      revision === undefined
        ? []
        : [revisionKey({ kind: 'workflow', name, revision })],
  }
}

/**
 * Fails a run that has been active for longer than its workflow allows, and
 * cancels what it has in flight. The limit is that of the program given, so
 * it applies to runs of exactly that program: a run of another revision, or
 * of this revision as other code, is left alone. So is a run `cancelling`.
 *
 * `false` when the run is not, or no longer, overdue; otherwise the task
 * runs it cancelled that wait for their handlers.
 */
export function planTimeout(
  program: AnyWorkflowProgram,
  runId: string,
): Plan<false | readonly StoredRun[]> {
  const { name, revision, timeout } = program
  const timeoutMs = parseDurationMs(timeout)

  return planning<false | readonly StoredRun[]>((draft) => {
    const run = draft.records(runId)?.run
    if (
      !run ||
      timeoutMs === undefined ||
      run.kind !== 'workflow' ||
      run.name !== name ||
      run.revision !== revision ||
      isTerminal(run.status) ||
      // Being cancelled, it ends so once the child runs it cancelled have:
      // failing it now would replace the outcome asked for first.
      run.status === 'cancelling' ||
      // Since its last manual retry, not since it was created.
      draft.now - run.activeSince <= timeoutMs ||
      drift(draft, run, program.definition)
    ) {
      return false
    }

    return failRun(draft, run, {
      name: 'RunTimeout',
      message: `Workflow run [${run.id}] timed out after [${timeout}]`,
    }).tasks
  })
}
