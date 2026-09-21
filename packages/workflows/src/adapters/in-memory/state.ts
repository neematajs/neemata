import type {
  AttemptCommand,
  ContinueRunCommand,
} from '../../runtime/commands.ts'
import type { StoredWorkflowSchedule } from '../../runtime/scheduler.ts'
import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type { RunLease } from '../../runtime/store.ts'
import type { ClaimedQueueItem, QueueItem } from './commands.ts'
import { createWakeEvents } from './wake-events.ts'

export type State = ReturnType<typeof createState>

type InMemoryRunLease = RunLease & {
  readonly expiresAt: Date
}

export function createState(maxDeliveries = 20) {
  let nextId = 1
  let lastTimestamp = 0

  function id(prefix: string) {
    return `${prefix}-${nextId++}`
  }

  // All adapter components share the clock and ID sequence so ordering and
  // lease fencing remain deterministic even within the same millisecond.
  function now() {
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1)
    return new Date(lastTimestamp)
  }

  const runs = new Map<string, StoredRun>()
  const nodes = new Map<string, StoredNode>()
  const attempts = new Map<string, StoredAttempt>()
  const children = new Map<string, StoredNodeChild>()
  const runIdempotencyKeys = new Map<string, string>()
  // in-process twins of the partial unique indexes: active entries are
  // released on terminal transitions, all-scope entries live with the run
  const activeUniqueRunKeys = new Map<string, string>()
  const allUniqueRunKeys = new Map<string, string>()
  const runLeases = new Map<string, InMemoryRunLease>()
  const continueRunCommands: QueueItem<ContinueRunCommand>[] = []
  const attemptCommands: QueueItem<AttemptCommand>[] = []
  const claimedContinueRunCommands = new Map<
    string,
    ClaimedQueueItem<ContinueRunCommand>
  >()
  const claimedAttemptCommands = new Map<
    string,
    ClaimedQueueItem<AttemptCommand>
  >()
  const schedules = new Map<string, StoredWorkflowSchedule>()

  const wake = createWakeEvents(runs)

  return {
    id,
    now,
    maxDeliveries,
    runs,
    nodes,
    attempts,
    children,
    runIdempotencyKeys,
    activeUniqueRunKeys,
    allUniqueRunKeys,
    runLeases,
    continueRunCommands,
    attemptCommands,
    claimedContinueRunCommands,
    claimedAttemptCommands,
    schedules,
    wake,
  }
}
