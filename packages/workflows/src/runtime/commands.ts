import type { DurationString, IdempotencyKey } from '../types/index.ts'
import type { StoredRun } from './state.ts'

export type WorkflowCommandKind = 'continue' | 'activity' | 'task'

export type ContinueRunCommand = {
  readonly kind: 'continueRun'
  readonly runId: string
  readonly workflowName: string
}

type AttemptCommandBase = {
  readonly workflowName: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly attemptId: string
  readonly leaseToken: string
  readonly input: unknown
  readonly idempotencyKey?: IdempotencyKey
}

export type ActivityAttemptCommand = AttemptCommandBase & {
  readonly kind: 'activityAttempt'
  readonly activityName: string
}

export type TaskAttemptCommand = AttemptCommandBase & {
  readonly kind: 'taskAttempt'
  readonly taskName: string
  readonly timeout?: DurationString
}

export type AttemptCommand = ActivityAttemptCommand | TaskAttemptCommand

export type WorkflowCommand = ContinueRunCommand | AttemptCommand

export type Claimed<Command extends WorkflowCommand> = {
  readonly id: string
  readonly command: Command
  readonly leaseToken: string
}

export type ClaimedCommand = Claimed<ContinueRunCommand>

export type ClaimedAttempt = Claimed<AttemptCommand>

export type RunCoordinationWorkerClaim = {
  readonly workerId: string
  readonly workflowNames: readonly string[]
  readonly leaseMs: number
}

export type ExecutionWorkerClaim = {
  readonly workerId: string
  readonly workflowNames: readonly string[]
  readonly activityNames?: readonly string[]
  readonly taskNames: readonly string[]
  readonly leaseMs: number
}

export function continueRun(
  run: Pick<StoredRun, 'id' | 'workflowName'>,
): ContinueRunCommand {
  return { kind: 'continueRun', runId: run.id, workflowName: run.workflowName }
}
