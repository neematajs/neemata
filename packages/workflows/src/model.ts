/**
 * The durable records of the engine, as plans read and write them. Adapters
 * store them whole and never interpret them, but for `STATUSES`.
 */

export type Timestamp = number

export type DurationString = `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`

export type RetryPolicy = {
  /** Attempts in total, the first one included. */
  readonly attempts: number
  readonly backoff?: 'fixed' | 'exponential'
  readonly delay?: DurationString
}

export type CancellationPolicy = 'propagate' | 'detach'

export type RunKind = 'workflow' | 'task'

export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  /**
   * A durable run with something only an operator can unblock: work that
   * failed under `onFailure: 'block'`, or a replay that no longer matches
   * what the run stored. Its other branches go on; it ends only once
   * resumed or cancelled.
   */
  | 'blocked'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type AttemptStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'cancelled'

/** What one child of a node runs. */
export type ChildKind = 'activity' | 'task' | 'workflow'

export type NodeKind =
  | ChildKind
  | 'branch'
  | 'parallel'
  | 'mapTask'
  | 'mapWorkflow'
  | WaitKind

/**
 * The nodes of a durable workflow that run nothing and have no children:
 * a durable sleep, an observation of the time, and a wait for an input sent
 * from outside the run.
 */
export type WaitKind = 'sleep' | 'now' | 'input'

export type RunUniqueScope = 'active' | 'all'
export type RunUniqueBehavior = 'reject' | 'join'

export type RunUnique = {
  readonly key: readonly unknown[]
  readonly scope: RunUniqueScope
  readonly behavior: RunUniqueBehavior
}

export type StoredError = {
  readonly name?: string
  readonly message: string
  readonly stack?: string
  readonly cause?: StoredError
}

/** User payloads in stored records are JSON, never decoded values. */
export type StoredRun = {
  readonly id: string
  readonly kind: RunKind
  readonly name: string
  readonly status: RunStatus
  readonly input: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly parentRunId?: string
  readonly parentNodeName?: string
  /**
   * The parent's route, set with `parentRunId`: a run that ends wakes its
   * parent from its own record, without reading the parent's.
   */
  readonly parentRoute?: Route
  readonly rootRunId: string
  readonly tags: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly unique?: RunUnique
  /** Immutable for the run's life: nothing changes what a run is pinned to. */
  readonly revision?: string
  /**
   * The graph the run was created with, saved under this hash. Immutable, and
   * absent when whatever created the run had no description of its program.
   */
  readonly graphHash?: string
  /**
   * The labels the run was created with, as the authoring layer wrote them.
   * Kept per run, so relabelling a definition changes no older run.
   */
  readonly presentation?: unknown
  readonly version: number
  readonly activeSince: Timestamp
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/** A run without its payloads. */
export type RunSummary = Omit<StoredRun, 'input' | 'output' | 'presentation'>

/**
 * A node aggregates its children: it owns ordering and the combined output,
 * while execution accounting (attempts, retries, child runs) lives on the
 * children.
 */
export type StoredNode = {
  readonly runId: string
  readonly name: string
  readonly kind: NodeKind
  readonly status: NodeStatus
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  /** A branch's choice, made once: a later pass never selects again. */
  readonly selectedCase?: string
  /** What a durable workflow's body asked the node to be; absent otherwise. */
  readonly operation?: StoredOperation
  readonly version: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/**
 * A node of a durable workflow, as its body first asked for it. Every later
 * pass replays the body and must ask for the same: what the node was opened
 * with is never changed to fit code that asks otherwise.
 */
export type StoredOperation = {
  /** The order the run admitted its nodes in, from 0. */
  readonly ordinal: number
  /** The task or workflow a `task` or `workflow` node starts a run of. */
  readonly target?: Route
  /**
   * When a `sleep` ends, or an `input` stops being waited for, as an
   * instant: replaying never moves it.
   */
  readonly until?: Timestamp
  /** Which input an `input` node is: its family and its key in it. */
  readonly input?: { readonly family: string; readonly key: string }
  /** When an `input` node's value was received. */
  readonly receivedAt?: Timestamp
  /** An `input` node whose wait ended with no value: its `until` came first. */
  readonly timedOut?: true
  /**
   * A `task` or `workflow` node whose work failed under `onFailure: 'block'`:
   * the body was never shown the failure, and `Client.resume` runs the work
   * again.
   */
  readonly blocked?: true
  /**
   * What the operation overrode of its task's limits, so the work can be
   * run again from what is stored, without the body's code.
   */
  readonly limits?: {
    readonly retry?: RetryPolicy
    readonly timeout?: DurationString
  }
}

/**
 * One unit of a node's execution. Attempts are retries of one child, so retry
 * budgets and the current attempt are per child by construction.
 */
export type StoredChild = {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly kind: ChildKind
  readonly status: NodeStatus
  /** A map item's position among the node's items. */
  readonly ordinal?: number
  /** The map item the child stands for. */
  readonly item?: unknown
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly childRunId?: string
  /**
   * Kept on the edge because cancellation walks the tree from stored state
   * alone, without workflow definitions. Absent means propagate.
   */
  readonly cancellation?: CancellationPolicy
  readonly currentAttemptId?: string
  readonly attemptCount: number
  readonly version: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type StoredAttempt = {
  readonly id: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly status: AttemptStatus
  /** Counts every attempt of the child, from 1. */
  readonly attemptNumber: number
  /** Counts attempts since the last manual retry, from 1: the retry budget. */
  readonly retryAttemptNumber: number
  readonly input: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly dispatchedAt: Timestamp
  readonly completedAt?: Timestamp
}

/**
 * A saved definition record: a graph under its hash, or the manifest of one
 * revision. Shared by every run that names it and immutable once saved: the
 * same key always holds the same value.
 */
export type DefinitionRecord = {
  readonly key: string
  /** JSON, compared as canonical text. */
  readonly value: unknown
}

/**
 * A schedule as it is stored: what it starts runs of, and the slot it fires
 * next. Written by a reconcile from what was declared, and by each fire.
 */
export type StoredSchedule = {
  readonly name: string
  /**
   * What a fire starts a run of. The revision, and the graph below, are those
   * the schedule was last reconciled with: every fire pins its run to them.
   */
  readonly runnable: {
    readonly kind: RunKind
    readonly name: string
    readonly revision?: string
  }
  readonly graphHash?: string
  readonly presentation?: unknown
  readonly input: unknown
  readonly tags: Readonly<Record<string, string>>
  /** One of `cron` and `everyMs` is set. */
  readonly cron?: string
  /**
   * The zone `cron` is read in. Absent only on a schedule written before
   * zones were recorded, which is read in the zone of whoever fires it.
   */
  readonly timeZone?: string
  readonly everyMs?: number
  readonly enabled: boolean
  /** The slot fired next. */
  readonly nextRunAt: Timestamp
  /** The slot fired last. */
  readonly lastSlotAt?: Timestamp
  readonly version: number
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

/**
 * A run with everything it owns. A store gives them in an order of its own;
 * the client gives them `ordered`, the same on every store.
 */
export type RunRecords = {
  readonly run: StoredRun
  readonly nodes: readonly StoredNode[]
  readonly children: readonly StoredChild[]
  readonly attempts: readonly StoredAttempt[]
}

/**
 * The key of the only child of a node that has no cases, members or items.
 * The other keys are prefixed, so no case or member a user names collides
 * with it.
 */
export const SELF = '$self'

export const caseKey = (key: string) => `case:${key}`
export const memberKey = (key: string) => `member:${key}`
export const itemKey = (ordinal: number) => `item:${ordinal}`

/** What a child key names within its node. */
export type ParsedChildKey =
  | { readonly kind: 'self' }
  | { readonly kind: 'case'; readonly caseKey: string }
  | { readonly kind: 'member'; readonly memberKey: string }
  | { readonly kind: 'item'; readonly itemIndex: number }

/** Reads a child key back; `undefined` for one the engine never wrote. */
export function parseChildKey(childKey: string): ParsedChildKey | undefined {
  if (childKey === SELF) return { kind: 'self' }
  const prefixed = (prefix: string) =>
    childKey.startsWith(prefix) ? childKey.slice(prefix.length) : undefined

  const ofCase = prefixed(caseKey(''))
  if (ofCase !== undefined) return { kind: 'case', caseKey: ofCase }
  const ofMember = prefixed(memberKey(''))
  if (ofMember !== undefined) return { kind: 'member', memberKey: ofMember }
  const ofItem = prefixed('item:')
  if (ofItem === undefined) return undefined
  // Only what `itemKey` writes for a position: `Number` alone would take
  // `1e2`, ` 7` and the empty string.
  const itemIndex = Number(ofItem)
  return Number.isInteger(itemIndex) &&
    itemIndex >= 0 &&
    itemKey(itemIndex) === childKey
    ? { kind: 'item', itemIndex }
    : undefined
}

/** The one node of a task run. */
export const TASK = '$task'

/**
 * All an adapter may know of what a record means, and only to keep indexes
 * and answer scans: which statuses end a run, node or child, which one
 * counts a node as done, and which a child waits in before it starts and is
 * in while under way. Everything else about a status is the plans'.
 */
export const STATUSES = {
  terminal: ['completed', 'failed', 'cancelled'],
  completed: 'completed',
  pending: 'pending',
  active: ['running', 'waiting', 'cancelling'],
} as const satisfies {
  readonly terminal: readonly (RunStatus & NodeStatus)[]
  readonly completed: RunStatus & NodeStatus
  readonly pending: NodeStatus
  readonly active: readonly NodeStatus[]
}

/**
 * The kinds of node whose children are the items of a list, and so may be
 * many: an adapter reads their children a window at a time, and their input,
 * the list, only when asked for it.
 */
export const MAPS = [
  'mapTask',
  'mapWorkflow',
] as const satisfies readonly NodeKind[]

export const isMap = (kind: NodeKind): boolean =>
  (MAPS as readonly string[]).includes(kind)

export type TerminalStatus = (typeof STATUSES.terminal)[number]

/** By code point, which the order of UTF-16 units is not past the BMP. */
export function byCodePoint(a: string, b: string) {
  // Names of one node or child compare most often, and need no splitting.
  if (a === b) return 0
  const left = Array.from(a)
  const right = Array.from(b)
  for (let at = 0; at < left.length && at < right.length; at++) {
    const order = left[at]!.codePointAt(0)! - right[at]!.codePointAt(0)!
    if (order !== 0) return order
  }
  return left.length - right.length
}

/**
 * A run's records in the one order a reader is given them, whatever order
 * its store keeps them in: nodes by name; children by node, a map's items by
 * index and any other by key; attempts by child, in the order they were made.
 * Names and keys compare by code point.
 */
export function ordered({
  run,
  nodes,
  children,
  attempts,
}: RunRecords): RunRecords {
  return {
    run,
    nodes: nodes.toSorted((a, b) => byCodePoint(a.name, b.name)),
    children: children.toSorted(
      (a, b) =>
        byCodePoint(a.nodeName, b.nodeName) ||
        (a.ordinal ?? 0) - (b.ordinal ?? 0) ||
        byCodePoint(a.childKey, b.childKey),
    ),
    attempts: attempts.toSorted(
      (a, b) =>
        byCodePoint(a.nodeName, b.nodeName) ||
        byCodePoint(a.childKey, b.childKey) ||
        a.attemptNumber - b.attemptNumber,
    ),
  }
}

export function isTerminal(status: RunStatus | NodeStatus): boolean {
  return (STATUSES.terminal as readonly string[]).includes(status)
}

/**
 * One served route. `revision` absent is the unversioned lane, never a
 * wildcard.
 */
export type Route = {
  readonly name: string
  readonly revision?: string
}

/**
 * Every command carries its run's route, because routing happens before a
 * worker can read the run: a claim matches name and revision exactly, so a
 * worker never takes work it has no code for.
 */
export type ContinueRun = Route & {
  readonly kind: 'continueRun'
  readonly runId: string
}

type Attempt = Route & {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly attemptId: string
  readonly input: unknown
}

/**
 * An attempt of an activity. Its route is its workflow's, whose step, case or
 * member at `nodeName` and `childKey` holds the handler.
 */
export type RunAttempt = Attempt & { readonly kind: 'runAttempt' }

/**
 * An attempt of a task run. Its route is the task's. A kind of its own,
 * because a task and a workflow may share a name: a claim then never hands a
 * worker of the one an attempt of the other.
 */
export type RunTask = Attempt & {
  readonly kind: 'runTask'
  /**
   * What the parent's step overrides of the task's own limits. They travel
   * with the command because the worker of a task knows nothing of the
   * workflows that use it.
   */
  readonly retry?: RetryPolicy
  readonly timeout?: DurationString
}

export type AttemptCommand = RunAttempt | RunTask

export type Command = ContinueRun | AttemptCommand

export function continueRun(
  run: Pick<StoredRun, 'id' | 'name' | 'revision'>,
): ContinueRun {
  const { id: runId, name, revision } = run
  return {
    kind: 'continueRun',
    runId,
    name,
    ...(revision === undefined ? {} : { revision }),
  }
}

/** How many causes of an error are kept, one under the other. */
const CAUSE_DEPTH = 5

/**
 * Whether a value reads as an error: an `Error`, or what is left of one that
 * crossed a wire, an object with a `message`.
 */
export function errorLike(value: unknown): value is {
  readonly name?: unknown
  readonly message: string
  readonly stack?: unknown
  readonly cause?: unknown
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'message' in value &&
    typeof value.message === 'string'
  )
}

/**
 * An error as it is stored: the fields of whatever reads as one, and the
 * text of anything else. Its causes are followed only so far: a chain that
 * comes back to itself would never end, and a failure that cannot be
 * recorded is a command delivered again instead of a run that failed.
 */
export function storedError(error: unknown, depth = CAUSE_DEPTH): StoredError {
  if (!errorLike(error)) return { message: String(error) }
  const { name, message, stack, cause } = error
  return {
    ...(typeof name === 'string' ? { name } : {}),
    message,
    ...(typeof stack === 'string' ? { stack } : {}),
    ...(cause === undefined || depth <= 0
      ? {}
      : { cause: storedError(cause, depth - 1) }),
  }
}

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * A duration in milliseconds, or nothing for what is not one. Exactly what
 * was written: the digits are multiplied as one whole number, so `1.001s` is
 * 1001 and not the 1000.9999999999999 that `1.001 * 1000` is. A duration
 * that is no whole number of milliseconds, as `1.5ms`, stays a fraction.
 */
export function parseDurationMs(
  duration: string | undefined,
): number | undefined {
  if (!duration) return undefined
  const match = /^(\d+)(?:\.(\d+))?(ms|s|m|h|d)$/.exec(duration)
  if (!match) return undefined

  const [, whole, fraction = '', unit] = match
  return (
    (Number(whole + fraction) * UNIT_MS[unit as keyof typeof UNIT_MS]) /
    10 ** fraction.length
  )
}
