import type {
  ActivityAttemptCommand,
  ActivityWorkerClaim,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  RunCoordinationWorkerClaim,
  TaskAttemptCommand,
  TaskWorkerClaim,
} from './commands.ts'

export type RunCoordinationExecutor = {
  enqueue(command: ContinueRunCommand): Promise<void>
  enqueueDelayed(command: ContinueRunCommand, runAt: Date): Promise<void>
  claim(worker: RunCoordinationWorkerClaim): Promise<ClaimedCommand | null>
  ack(command: ClaimedCommand): Promise<void>
  release(command: ClaimedCommand): Promise<void>
}

export type AttemptExecutor = {
  dispatchActivity(command: ActivityAttemptCommand): Promise<void>
  dispatchTask(command: TaskAttemptCommand): Promise<void>
  claimActivity(worker: ActivityWorkerClaim): Promise<ClaimedAttempt | null>
  claimTask(worker: TaskWorkerClaim): Promise<ClaimedAttempt | null>
  heartbeat(attempt: ClaimedAttempt): Promise<void>
  ack(attempt: ClaimedAttempt): Promise<void>
  release(attempt: ClaimedAttempt): Promise<void>
}
