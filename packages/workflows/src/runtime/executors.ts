import type {
  ActivityAttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  ExecutionWorkerClaim,
  RunCoordinationWorkerClaim,
  TaskAttemptCommand,
} from './commands.ts'
import type { RuntimeRunStatus } from './status.ts'

/**
 * Single home for the fallback lease duration so the worker loop and both
 * adapters' heartbeat defaults cannot drift apart — the value now decides
 * when an expired lease counts as a lost delivery.
 */
export const DEFAULT_LEASE_MS = 30_000

export type CommandReleaseOptions = {
  readonly error?: unknown
  /**
   * 'unroutable' — no implementation can execute this command (unknown
   * workflow/task or unresolvable member). Counts toward dead-lettering with
   * a longer backoff, so definition drift surfaces in dead commands instead
   * of an unbounded claim/release loop. A plain release (no error, no reason)
   * stays uncounted — it means "expected to succeed on redelivery" (worker
   * shutdown, lease loss). Crashed deliveries never release at all: claiming
   * a command whose lease expired counts the lost delivery instead, so poison
   * commands that keep killing workers still reach dead-lettering.
   */
  readonly reason?: 'unroutable'
}

export type AttemptHeartbeatResult = {
  readonly runStatus: RuntimeRunStatus
}

export type RunCoordinationExecutor = {
  enqueue(command: ContinueRunCommand): Promise<void>
  enqueueDelayed(command: ContinueRunCommand, runAt: Date): Promise<void>
  /**
   * Continue commands have no heartbeat, so a continuation that outlives
   * `leaseMs` loses its lease and the takeover counts a delivery even though
   * the worker is healthy. Accumulation is bounded (~1 per slow pass — the
   * original executor still advances run state, so redelivered copies no-op
   * and ack), but `leaseMs` must comfortably exceed the worst-case
   * continuation time relative to `maxDeliveries`.
   */
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
  claim(worker: ExecutionWorkerClaim): Promise<ClaimedAttempt | null>
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
