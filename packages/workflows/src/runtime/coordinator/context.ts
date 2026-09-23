import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { HandlerRunner } from '../handler.ts'
import type { RegisteredWorkflowImplementation } from '../registry.ts'
import type { StoredRun } from '../state.ts'
import type { WorkflowStore } from '../store.ts'

export type RuntimeDeps = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
}

/**
 * What an advance pass left behind, so the coordinator can persist a truthful
 * run status: 'local' — attempt/coordination commands for this run are pending
 * or executing (run stays `running`); 'parked' — blocked on child runs or
 * timers with nothing local to execute (run becomes `waiting`); 'terminal' —
 * a sink already moved the run to a terminal status.
 */
export type AdvanceOutcome = 'local' | 'parked' | 'terminal'

export type AdvanceCtx = RuntimeDeps & {
  // The typed worker entry points proved `env` covers this implementation.
  readonly workflow: RegisteredWorkflowImplementation
  readonly signal: AbortSignal
  readonly handlers: HandlerRunner
  readonly env?: unknown
  readonly run: StoredRun
  /** Decoded Type for user callbacks; run retains its stored JSON representation. */
  readonly workflowInput: unknown
  readonly outputs: Record<string, unknown>
  readonly advance: (ctx: AdvanceCtx) => Promise<AdvanceOutcome>
}

export class WorkflowUserCallbackError extends Error {
  constructor(readonly error: unknown) {
    super(error instanceof Error ? error.message : String(error))
    this.name = 'WorkflowUserCallbackError'
  }
}

export const isWorkflowUserCallbackError = (
  error: unknown,
): error is WorkflowUserCallbackError =>
  error instanceof WorkflowUserCallbackError

export const unwrapWorkflowUserCallbackError = (
  error: WorkflowUserCallbackError,
) => error.error

export function runWorkflowUserCallback<T>(callback: () => T): T {
  try {
    return callback()
  } catch (error) {
    throw new WorkflowUserCallbackError(error)
  }
}
