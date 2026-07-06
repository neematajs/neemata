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
import type { RuntimeRunStatus } from './status.ts'

export type CommandReleaseOptions = {
  readonly error?: unknown
  /**
   * 'unroutable' — no implementation can execute this command (unknown
   * workflow/task or unresolvable member). Counts toward dead-lettering with
   * a longer backoff, so definition drift surfaces in dead commands instead
   * of an unbounded claim/release loop. A plain release (no error, no reason)
   * stays uncounted — it means "expected to succeed on redelivery" (worker
   * shutdown, lease loss).
   */
  readonly reason?: 'unroutable'
}

export type AttemptHeartbeatResult = {
  readonly runStatus: RuntimeRunStatus
}

export type RunCoordinationExecutor = {
  enqueue(command: ContinueRunCommand): Promise<void>
  enqueueDelayed(command: ContinueRunCommand, runAt: Date): Promise<void>
  claim(worker: RunCoordinationWorkerClaim): Promise<ClaimedCommand | null>
  ack(command: ClaimedCommand): Promise<void>
  release(
    command: ClaimedCommand,
    options?: CommandReleaseOptions,
  ): Promise<void>
}

export type AttemptExecutor = {
  dispatchActivity(
    command: ActivityAttemptCommand,
    options?: { readonly runAt?: Date },
  ): Promise<void>
  dispatchTask(
    command: TaskAttemptCommand,
    options?: { readonly runAt?: Date },
  ): Promise<void>
  claimActivity(worker: ActivityWorkerClaim): Promise<ClaimedAttempt | null>
  claimTask(worker: TaskWorkerClaim): Promise<ClaimedAttempt | null>
  heartbeat(
    attempt: ClaimedAttempt,
    leaseMs?: number,
  ): Promise<AttemptHeartbeatResult>
  ack(attempt: ClaimedAttempt): Promise<void>
  release(
    attempt: ClaimedAttempt,
    options?: CommandReleaseOptions,
  ): Promise<void>
  deleteUnclaimed(params: { readonly runId: string }): Promise<number>
}
