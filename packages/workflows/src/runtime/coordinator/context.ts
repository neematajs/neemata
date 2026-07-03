import type { DependencyContext } from '@nmtjs/core'

import type { WorkflowImplementation } from '../../implement/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredRun } from '../state.ts'
import type { WorkflowStore } from '../store.ts'

export type RuntimeDeps = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
}

export type AdvanceCtx = RuntimeDeps & {
  readonly workflow: WorkflowImplementation
  readonly workflowCtx: DependencyContext<any>
  readonly run: StoredRun
  readonly outputs: Record<string, unknown>
  readonly advance: (ctx: AdvanceCtx) => Promise<void>
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
