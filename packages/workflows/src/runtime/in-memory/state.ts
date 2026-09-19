import type {
  AttemptCommand,
  ContinueRunCommand,
  WorkflowCommandKind,
} from '../commands.ts'
import type { StoredWorkflowSchedule } from '../scheduler.ts'
import type {
  StoredAttempt,
  StoredError,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../state.ts'
import type { NodeChildRef, RunLease } from '../store.ts'

export type InMemoryRunLease = RunLease & {
  readonly expiresAt: Date
}

export type QueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Date
  readonly deliveryCount: number
  readonly lastError?: StoredError
  readonly deadAt?: Date
  readonly reapedAt?: Date
  readonly createdAt: Date
}

export type ClaimedQueueItem<T> = QueueItem<T> & {
  readonly leaseToken: string
  readonly leaseExpiresAt: Date
}

export type InspectQueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Date
}

export type State = ReturnType<typeof createState>

export function createState(maxDeliveries: number) {
  let nextId = 1
  let lastTimestamp = 0

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
  const continueCommands: QueueItem<ContinueRunCommand>[] = []
  const attemptCommands: QueueItem<AttemptCommand>[] = []
  const claimedContinueCommands = new Map<
    string,
    ClaimedQueueItem<ContinueRunCommand>
  >()
  const claimedAttemptCommands = new Map<
    string,
    ClaimedQueueItem<AttemptCommand>
  >()
  const schedules = new Map<string, StoredWorkflowSchedule>()
  const commandWakeListeners = new Map<WorkflowCommandKind, Set<() => void>>()
  const cancellationWakeListeners = new Map<string, Set<() => void>>()
  const runEventWakeListeners = new Map<string, Set<() => void>>()

  const newId = (prefix: string) => `${prefix}-${nextId++}`
  // Strictly increasing so rows written in the same millisecond still sort in
  // write order, which the queue and listing comparators rely on.
  const now = () => {
    const current = Date.now()
    lastTimestamp = Math.max(current, lastTimestamp + 1)
    return new Date(lastTimestamp)
  }

  const fire = (listeners: Set<() => void> | undefined) => {
    if (!listeners) return
    for (const listener of listeners) listener()
  }
  const subscribe = <K>(
    listeners: Map<K, Set<() => void>>,
    key: K,
    listener: () => void,
  ) => {
    const set = listeners.get(key) ?? new Set<() => void>()
    listeners.set(key, set)
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    }
  }

  // Nothing is persisted for status changes: the wake hub is the in-process
  // twin of the Postgres NOTIFY hint, and watchers re-read state on it.
  const emitRunEvent = (run: StoredRun) =>
    fire(runEventWakeListeners.get(run.rootRunId))
  const emitStatusChange = (
    before: { readonly status: string } | undefined,
    after: { readonly runId: string; readonly status: string },
  ) => {
    if (before?.status === after.status) return
    const rootRunId = runs.get(after.runId)?.rootRunId ?? after.runId
    fire(runEventWakeListeners.get(rootRunId))
  }

  return {
    maxDeliveries,
    runs,
    nodes,
    attempts,
    children,
    runIdempotencyKeys,
    activeUniqueRunKeys,
    allUniqueRunKeys,
    runLeases,
    continueCommands,
    attemptCommands,
    claimedContinueCommands,
    claimedAttemptCommands,
    schedules,
    commandWakeListeners,
    cancellationWakeListeners,
    runEventWakeListeners,
    newId,
    now,
    subscribe,
    fire,
    emitRunEvent,
    emitStatusChange,
  }
}

export function nodeKey(runId: string, nodeName: string): string {
  return `${runId}:${nodeName}`
}

export function childMapKey(ref: NodeChildRef): string {
  return `${ref.runId}:${ref.nodeName}:${ref.childKey}`
}

/** Human-readable child address used in error messages. */
export function describeChild(ref: NodeChildRef): string {
  return `${ref.runId}.${ref.nodeName}.${ref.childKey}`
}

export function runNodes(state: State, runId: string): StoredNode[] {
  const rows: StoredNode[] = []

  for (const node of state.nodes.values()) {
    if (node.runId === runId) rows.push(node)
  }

  return rows
}

export function runChildren(state: State, runId: string): StoredNodeChild[] {
  const rows: StoredNodeChild[] = []

  for (const child of state.children.values()) {
    if (child.runId === runId) rows.push(child)
  }

  return rows
}

export function runAttempts(state: State, runId: string): StoredAttempt[] {
  const rows: StoredAttempt[] = []

  for (const attempt of state.attempts.values()) {
    if (attempt.runId === runId) rows.push(attempt)
  }

  return rows
}

export function nodeChildren(
  state: State,
  runId: string,
  nodeName: string,
): StoredNodeChild[] {
  const rows: StoredNodeChild[] = []

  for (const child of state.children.values()) {
    if (child.runId === runId && child.nodeName === nodeName) rows.push(child)
  }

  return rows
}

export function nodeAttempts(
  state: State,
  runId: string,
  nodeName: string,
): StoredAttempt[] {
  const rows: StoredAttempt[] = []

  for (const attempt of state.attempts.values()) {
    if (attempt.runId === runId && attempt.nodeName === nodeName) {
      rows.push(attempt)
    }
  }

  return rows
}

/** The child's highest-numbered attempt; the current one unless retry cleared it. */
export function latestAttempt(
  state: State,
  child: StoredNodeChild,
): StoredAttempt | undefined {
  if (child.currentAttemptId !== undefined) {
    const current = state.attempts.get(child.currentAttemptId)
    if (current) return current
  }

  let latest: StoredAttempt | undefined
  for (const attempt of state.attempts.values()) {
    if (
      attempt.runId !== child.runId ||
      attempt.nodeName !== child.nodeName ||
      attempt.childKey !== child.childKey
    ) {
      continue
    }
    if (latest === undefined || attempt.attemptNumber > latest.attemptNumber) {
      latest = attempt
    }
  }

  return latest
}

export function sortedChildren(
  rows: readonly StoredNodeChild[],
): StoredNodeChild[] {
  return [...rows].sort((left, right) => {
    const byOrdinal = left.ordinal - right.ordinal
    if (byOrdinal !== 0) return byOrdinal
    return left.childKey.localeCompare(right.childKey)
  })
}

export function compareAttempts(
  left: StoredAttempt,
  right: StoredAttempt,
): number {
  const byDispatchedAt =
    left.dispatchedAt.getTime() - right.dispatchedAt.getTime()
  if (byDispatchedAt !== 0) return byDispatchedAt
  return left.id.localeCompare(right.id)
}

export function compareRunsOldest(left: StoredRun, right: StoredRun): number {
  const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime()
  if (byCreatedAt !== 0) return byCreatedAt
  return left.id.localeCompare(right.id)
}

export function compareRunsNewest(left: StoredRun, right: StoredRun): number {
  return compareRunsOldest(right, left)
}
