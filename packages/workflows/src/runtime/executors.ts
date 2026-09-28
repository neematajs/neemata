import type { Timestamp } from '../types/index.ts'
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
import type { Fenced } from './store.ts'

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

export type AttemptDispatchOptions = {
  readonly runAt?: Timestamp
}

export type UnservedWorkflowQuery = {
  /** The workflows the asking coordinator claims; their commands never count. */
  readonly workflowNames: readonly string[]
  /** Only commands due at or before this time count. */
  readonly dueBefore: Timestamp
  /** How many of the oldest queued commands to inspect at most. */
  readonly limit: number
}

export type UnservedWorkflow = {
  readonly workflowName: string
  /** A lower bound when more than `limit` commands are queued. */
  readonly count: number
  readonly oldestDueAt: Timestamp
}

/** Groups inspected queue entries the way every adapter reports them. */
export function groupUnservedWorkflows(
  query: UnservedWorkflowQuery,
  queued: Iterable<{
    readonly workflowName: string
    readonly dueAt: Timestamp
  }>,
): readonly UnservedWorkflow[] {
  const served = new Set(query.workflowNames)
  const groups = new Map<string, { count: number; oldestDueAt: Timestamp }>()
  for (const { workflowName, dueAt } of queued) {
    if (served.has(workflowName) || dueAt > query.dueBefore) continue
    const group = groups.get(workflowName)
    if (group === undefined) {
      groups.set(workflowName, { count: 1, oldestDueAt: dueAt })
      continue
    }
    group.count += 1
    group.oldestDueAt = Math.min(group.oldestDueAt, dueAt)
  }
  return [...groups]
    .map(([workflowName, group]) => ({ workflowName, ...group }))
    .sort(
      (left, right) =>
        left.oldestDueAt - right.oldestDueAt ||
        (left.workflowName < right.workflowName ? -1 : 1),
    )
}

export type RunCoordinationExecutor = {
  enqueue(command: ContinueRunCommand): Promise<void>
  enqueueDelayed(command: ContinueRunCommand, runAt: Timestamp): Promise<void>
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
  /**
   * Unclaimed continue commands for workflows outside the query's names,
   * grouped by workflow. Coordinators claim only the names they serve, so a
   * run nobody serves never reaches release or dead-lettering; this is how a
   * coordinator notices it. Only the oldest commands are inspected, which keeps
   * the diagnostic cheap on a large queue: those are the ones stuck longest.
   * Ordered by the oldest due time.
   */
  listUnserved(
    query: UnservedWorkflowQuery,
  ): Promise<readonly UnservedWorkflow[]>
}

export type AttemptExecutor = {
  dispatchActivity(
    command: ActivityAttemptCommand,
    options?: AttemptDispatchOptions,
  ): Promise<void>
  dispatchTask(
    command: TaskAttemptCommand,
    options?: AttemptDispatchOptions,
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
  /** Fenced like a store write: cancellation must not outlive its authority. */
  deleteUnclaimed(params: Fenced<{ readonly runId: string }>): Promise<number>
}
