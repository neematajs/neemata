import type * as Effect from 'effect/Effect'
import type * as Scope from 'effect/Scope'
import * as Context from 'effect/Context'

import type { StaleClaim, StorageError } from './errors.ts'
import type {
  Command,
  DefinitionRecord,
  Route,
  RunKind,
  RunRecords,
  RunStatus,
  RunSummary,
  StoredAttempt,
  StoredChild,
  StoredError,
  StoredNode,
  StoredRun,
  StoredSchedule,
  Timestamp,
} from './model.ts'

/**
 * One unit of a run's work: a child of a node, with one of its attempts.
 * What a plan acting on one attempt needs, and not what else the run owns.
 */
export type UnitRead = {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  /** The child's current attempt when omitted. */
  readonly attemptId?: string
}

/**
 * What a unit read found: each record, or `undefined` for one that is
 * absent. An attempt is found only under the child it names: one of another
 * child, or of another run, is absent here.
 */
export type UnitRecords = {
  readonly run: StoredRun | undefined
  readonly node: StoredNode | undefined
  readonly child: StoredChild | undefined
  readonly attempt: StoredAttempt | undefined
}

/**
 * The key a unit is loaded under. A JSON tuple, as a name or a key may hold
 * whatever would join them; a current attempt's is one element shorter.
 */
export const unitKey = ({ runId, nodeName, childKey, attemptId }: UnitRead) =>
  JSON.stringify(
    attemptId === undefined
      ? [runId, nodeName, childKey]
      : [runId, nodeName, childKey, attemptId],
  )

/**
 * A map node of a run that is opened: its children under way are read, and
 * of those waiting the first `pendingLimit` by ordinal.
 */
export type MapRead = {
  readonly nodeName: string
  /** A positive integer; `'all'` for a map that runs every item at once. */
  readonly pendingLimit: number | 'all'
}

/**
 * A run as a coordination pass reads it: its record, every node, and of the
 * nodes that have not ended the children they wait on, but a map's in a
 * window. What a pass reads stays near what it may start, however many
 * children are done or yet to come.
 */
export type OpenRead = {
  readonly runId: string
  /**
   * The maps of the run's program, which the plan names: an adapter reads
   * no workflow. A map node not named has none of its children read.
   */
  readonly maps: readonly MapRead[]
  /**
   * Whether the runs of its children are read with them, which they are
   * unless this says not: `false` of a program that starts no runs. A pass
   * then asks for any it finds, as it does for one an adapter left out.
   */
  readonly linked?: boolean
}

/**
 * The runs a scope opens whose children's runs are read with them: those
 * of which any read leaves `linked` unsaid or sets it.
 */
export function linking(scope: ReadScope): ReadonlySet<string> {
  const runs = new Set<string>()
  for (const { runId, linked } of scope.open ?? []) {
    if (linked !== false) runs.add(runId)
  }
  return runs
}

/** A node with its input and all its children, to make up its outcome. */
export type ResultsRead = {
  readonly runId: string
  readonly nodeName: string
}

/** The key the results of a node are loaded under, a JSON tuple. */
export const resultsKey = ({ runId, nodeName }: ResultsRead) =>
  JSON.stringify([runId, nodeName])

/** A node without its input: how a map's is read, whose input is its list. */
export type NodeWithoutInput = Omit<StoredNode, 'input'>

/** A node as it was read: whole, or without its input, which is not absent. */
export type NodeRead =
  | { readonly view: 'full'; readonly record: StoredNode }
  | { readonly view: 'withoutInput'; readonly record: NodeWithoutInput }

/** The children of one node an open read gives, and how far they reach. */
export type ChildSet =
  /** Every child of the node. */
  | { readonly view: 'all'; readonly children: readonly StoredChild[] }
  | {
      readonly view: 'map'
      /** Every child of the node under way: of `STATUSES.active`. */
      readonly active: readonly StoredChild[]
      /** The first of those waiting, by ordinal, `pendingLimit` at most. */
      readonly pending: readonly StoredChild[]
      readonly pendingLimit: number | 'all'
      /** Whether more wait than `pending` holds. */
      readonly hasMore: boolean
    }

/** What an open read found of a run. */
export type OpenRecords = {
  readonly run: StoredRun
  /** Every node of the run, a map's without its input. */
  readonly nodes: readonly NodeRead[]
  /**
   * By node name, for every node that has not ended but a map the read did
   * not name. A node that has ended has none of its children read.
   */
  readonly childSets: ReadonlyMap<string, ChildSet>
  /** The current attempts of the children read, and no other attempt. */
  readonly attempts: readonly StoredAttempt[]
  /**
   * The runs of the children read that have not ended, by id, each found or
   * absent: what a pass observes of them. Each is guarded as a head is. An
   * adapter that could not guard one leaves it out, and the plan asks.
   */
  readonly linked: ReadonlyMap<string, StoredRun | undefined>
}

/** What a results read found. */
export type ChildResults = {
  /** The node, its input included; `undefined` when absent. */
  readonly node: StoredNode | undefined
  /** Every child of the node, by ordinal. No attempt is read. */
  readonly children: readonly StoredChild[]
}

/**
 * The maps each run of a scope is opened with: of several reads of one map,
 * the larger limit, `'all'` larger than any. A run loaded whole is not
 * opened, as it is read whole already.
 */
export function opened(
  scope: ReadScope,
): ReadonlyMap<string, ReadonlyMap<string, number | 'all'>> {
  const runs = new Map<string, Map<string, number | 'all'>>()
  if (!scope.open?.length) return runs
  const whole = new Set(scope.runs)
  for (const { runId, maps } of scope.open ?? []) {
    if (whole.has(runId)) continue
    const limits = runs.get(runId) ?? new Map<string, number | 'all'>()
    runs.set(runId, limits)
    for (const { nodeName, pendingLimit } of maps) {
      if (
        pendingLimit !== 'all' &&
        !(Number.isSafeInteger(pendingLimit) && pendingLimit > 0)
      ) {
        throw new Error(`Pending limit [${pendingLimit}] of [${nodeName}]`)
      }
      const had = limits.get(nodeName)
      limits.set(
        nodeName,
        had === 'all' || pendingLimit === 'all'
          ? 'all'
          : Math.max(had ?? 0, pendingLimit),
      )
    }
  }
  return runs
}

/**
 * What a plan needs loaded. Everything loaded is also guarded: the mutation
 * commits only if none of it, absence included, changed since it was read.
 */
export type ReadScope = {
  /** Runs with their nodes, children and attempts. */
  readonly runs?: readonly string[]
  /** Run records alone, for runs a plan only looks at or nudges. */
  readonly heads?: readonly string[]
  /**
   * Units of work: each with its run's record, its node, its child and the
   * attempt asked for, by direct lookups that read nothing else the run
   * owns. Guarded as its run is, by any write to the run. A plan writes of
   * them only what was found, and an attempt under a child it found, made
   * with an id of the snapshot's.
   */
  readonly units?: readonly UnitRead[]
  /**
   * Runs as a coordination pass reads them, by direct lookups and windows
   * of ordered indexes: never all a run owns. Guarded as their run is.
   */
  readonly open?: readonly OpenRead[]
  /**
   * Nodes with their input and every child, without attempts: what a map
   * that is done is made up from, once. Guarded as their run is.
   */
  readonly childResults?: readonly ResultsRead[]
  /** Identity keys, resolved to the run holding each. */
  readonly keys?: readonly string[]
  /** Saved definition records, by key. */
  readonly definitions?: readonly string[]
  /** Schedule records, by name. */
  readonly schedules?: readonly string[]
  /**
   * The names of all schedules. It guards which schedules exist, and so is
   * what a plan that adds or removes one must have loaded.
   */
  readonly scheduleNames?: true
  /** Families, by the id of their root run. */
  readonly families?: readonly string[]
  /**
   * Dead commands, by id. Guarded as everything loaded is: the plan runs
   * again when one that was loaded has been removed or queued again before
   * the commit, and when one that was loaded as absent has appeared.
   */
  readonly dead?: readonly string[]
}

/**
 * A run and the runs under it, those whose `rootRunId` it is, as far as
 * deciding to remove them takes: no run but the root is loaded. A run that
 * is no root has none under it, itself included: its counts are zero.
 *
 * The root's record and the two counts are guarded. `claimed` is not, as
 * nothing guards a claim: it is what was true when the family was read.
 */
export type Family = {
  readonly root: RunSummary
  /** How many runs it has, the root included. */
  readonly size: number
  /** How many of them have not ended. */
  readonly active: number
  /** One of those that have not ended, if any. */
  readonly activeRunId?: string
  /**
   * One of its runs with a command under a claim whose lease has not ended,
   * if any: a worker may be running work of it right now.
   */
  readonly claimedRunId?: string
}

/** A scope with what a plan asked to have loaded as well. */
export function widened(scope: ReadScope, more: ReadScope): ReadScope {
  const both = <A>(a: readonly A[] = [], b: readonly A[] = []) => [...a, ...b]
  return {
    runs: both(scope.runs, more.runs),
    heads: both(scope.heads, more.heads),
    units: both(scope.units, more.units),
    open: both(scope.open, more.open),
    childResults: both(scope.childResults, more.childResults),
    keys: both(scope.keys, more.keys),
    definitions: both(scope.definitions, more.definitions),
    schedules: both(scope.schedules, more.schedules),
    families: both(scope.families, more.families),
    dead: both(scope.dead, more.dead),
    ...(scope.scheduleNames || more.scheduleNames
      ? { scheduleNames: true }
      : {}),
  }
}

/**
 * What was loaded. A map without an entry means "not loaded"; an entry of
 * `undefined` means "loaded, and absent".
 */
export type Snapshot = {
  /** The store's clock: the only time a plan may use. */
  readonly now: Timestamp
  /** A fresh id. Ids of a plan that is not committed are simply never used. */
  readonly id: (prefix: string) => string
  readonly runs: ReadonlyMap<string, RunRecords | undefined>
  readonly heads: ReadonlyMap<string, StoredRun | undefined>
  /** By `unitKey`; an entry is there for every unit asked for. */
  readonly units: ReadonlyMap<string, UnitRecords>
  /** By run id, of each run opened that was not loaded whole. */
  readonly open: ReadonlyMap<string, OpenRecords | undefined>
  /** By `resultsKey`; an entry is there for every node asked for. */
  readonly childResults: ReadonlyMap<string, ChildResults>
  readonly keys: ReadonlyMap<string, string | undefined>
  /** The value saved under each key. */
  readonly definitions: ReadonlyMap<string, unknown>
  readonly schedules: ReadonlyMap<string, StoredSchedule | undefined>
  /** In no order; `undefined` when the scope did not ask for them. */
  readonly scheduleNames: readonly string[] | undefined
  readonly families: ReadonlyMap<string, Family | undefined>
  /** Dead commands, by id; `undefined` for an id that names none. */
  readonly dead: ReadonlyMap<string, DeadCommand | undefined>
}

export type KeyChange = {
  /** `acquire` needs the key free; `release` needs it held by `runId`. */
  readonly op: 'acquire' | 'release'
  readonly key: string
  readonly runId: string
}

export type Enqueue = {
  readonly command: Command
  readonly availableAt?: Timestamp
  /**
   * Not added while an unclaimed command with this key waits. The one that
   * waits is then due no later than this one would have been: its
   * `availableAt` becomes the earlier of the two, and a hint is sent when
   * it may be due. A claimed one does not count: a wake that arrives
   * during a pass must outlive it.
   *
   * Added or not, it removes the dead commands with this key: a command
   * queued again for the same work is what decides that work now.
   */
  readonly dedupe: string
}

/** A claimed command: proof of the right to act on it until the lease ends. */
export type Claim<C extends Command = Command> = {
  readonly id: string
  readonly token: string
  readonly command: C
  /**
   * How many deliveries count against the command, this one included: every
   * claim but those released without an error.
   */
  readonly deliveries: number
  /** When the command was queued. */
  readonly createdAt: Timestamp
  /**
   * When the command became due: when it was queued, unless it was queued
   * for later or given back with a delay, or an earlier wake was merged into
   * it. A lease that ended does not move it, so a delivery after one counts
   * the time the delivery before it held the command.
   */
  readonly availableAt: Timestamp
  /** When this delivery claimed it. Store time, as the two above are. */
  readonly claimedAt: Timestamp
}

/**
 * A command set aside because it was delivered too often. It is delivered no
 * more, and stays until a command with its key is queued again.
 */
export type DeadCommand = {
  readonly id: string
  readonly command: Command
  /** The deliveries that counted against it. */
  readonly deliveries: number
  /** What its last release with an error gave; none when leases only ended. */
  readonly error?: StoredError
  readonly createdAt: Timestamp
  readonly deadAt: Timestamp
}

/** Whole new versions of records, applied all or nothing. */
export type Mutation = {
  readonly runs?: readonly StoredRun[]
  readonly nodes?: readonly StoredNode[]
  /**
   * Nodes that exist, written but for their input, which is kept as stored:
   * a map's, read without it. Never one also among `nodes`.
   */
  readonly nodesPreservingInput?: readonly NodeWithoutInput[]
  readonly children?: readonly StoredChild[]
  readonly attempts?: readonly StoredAttempt[]
  readonly keys?: readonly KeyChange[]
  /**
   * Saved for good. Each key was loaded and seen absent: a saved record is
   * never replaced, so a plan that finds one compares it and writes nothing.
   */
  readonly definitions?: readonly DefinitionRecord[]
  /**
   * Each was loaded by name. One that did not exist is added, which needs
   * `scheduleNames` loaded too.
   */
  readonly schedules?: readonly StoredSchedule[]
  /** Schedules removed, by name: each was loaded, and `scheduleNames` too. */
  readonly unschedule?: readonly string[]
  /**
   * Families removed whole, by the id of their root: each was loaded as a
   * family. Every run under the root goes, with all it owns, the keys it
   * holds and its commands, queued, claimed or dead. Definitions are shared
   * and stay. A plan removes a family or writes to it, never both.
   */
  readonly remove?: readonly string[]
  readonly enqueue?: readonly Enqueue[]
  /** Removed with the commit; all must still be held. */
  readonly ack?: readonly Claim[]
  /**
   * Claims that must still be held when the mutation commits, checked as
   * those of `ack` are and kept: with one that is no longer held the
   * mutation fails with `StaleClaim` and nothing of it is applied.
   */
  readonly hold?: readonly Claim[]
  /**
   * Topics hinted to their listeners once the commit is applied. Nothing is
   * stored: a store that gives no hints ignores them.
   */
  readonly notify?: readonly string[]
}

/**
 * The runs whose record a read of the snapshot found: of the runs a mutation
 * writes, the ones it writes over. Any other it creates, guarded or not.
 */
export function foundRuns(snapshot: Snapshot): Set<string> {
  const found = new Set<string>()
  for (const [id, records] of snapshot.runs) if (records) found.add(id)
  for (const [id, run] of snapshot.heads) if (run) found.add(id)
  for (const { run } of snapshot.units.values()) if (run) found.add(run.id)
  for (const [id, records] of snapshot.open) {
    if (!records) continue
    found.add(id)
    for (const [linked, run] of records.linked) if (run) found.add(linked)
  }
  return found
}

/**
 * The first record of what runs own that a mutation writes without its plan
 * having loaded it, named as a guard is, or nothing: a defect of the plan's,
 * which an adapter refuses before it writes. What a run owns is written by a
 * plan that loaded the run whole or creates it. Of any other run, a plan
 * writes what it read, and what it read is absent:
 *
 * - a node it read whole, or one it read without its input preserving that
 *   input, and never its input then; a node no open read of the run found,
 *   which it creates;
 * - a child it read; any child of a node whose children it read all, or of
 *   a node it creates. Never one of a node that is absent and that it does
 *   not create: an adapter finds what a run owns by its nodes;
 * - an attempt it read, or one it makes, with an id `minted` by the
 *   snapshot, under a child it may write.
 *
 * That the run is guarded is not enough: what was not read would be written
 * over unseen. Nor is a window of a map's children enough to create one, as
 * what lies outside it was not seen to be absent.
 *
 * A run written that no read found is taken for one the mutation creates;
 * the adapter refuses it when it exists, and so is one a family read shows
 * to exist: its guard is the family's, and its record was not read.
 */
export function unloaded(
  snapshot: Snapshot,
  mutation: Mutation,
  minted: (id: string) => boolean,
): string | undefined {
  const owns =
    mutation.nodes?.length ||
    mutation.nodesPreservingInput?.length ||
    mutation.children?.length ||
    mutation.attempts?.length
  // Of a mutation that writes nothing a run owns, only a run that a family
  // read shows to exist may be refused.
  if (!owns && snapshot.families.size === 0) return undefined
  const tuple = (...parts: readonly string[]) => JSON.stringify(parts)
  // Runs the mutation creates: written, and found by no read.
  let created: Set<string> | undefined
  if (mutation.runs?.length) {
    const found = foundRuns(snapshot)
    for (const { id } of mutation.runs) {
      if (found.has(id)) continue
      if (snapshot.families.get(id)) return `run:${id}`
      ;(created ??= new Set()).add(id)
    }
  }
  if (!owns) return undefined
  const all = (runId: string) =>
    snapshot.runs.has(runId) || created?.has(runId) === true
  const read = new Coverage(snapshot)

  // Nodes kept but for their input, and written whole, by run.
  const kept = new Map<string, Set<string>>()
  for (const record of mutation.nodesPreservingInput ?? []) {
    const { runId, name } = record
    const named = `node:${tuple(runId, name)}`
    // Its input, even as `undefined`, is what such a write does not write.
    if (Object.hasOwn(record, 'input')) return `input of ${named}`
    if (!all(runId) && read.node(runId, name) === undefined) return named
    add(kept, runId, name)
  }
  const whole = new Map<string, Set<string>>()
  for (const { runId, name } of mutation.nodes ?? []) {
    // One write of a node: its input is either written or kept.
    if (kept.get(runId)?.has(name)) return `node:${tuple(runId, name)}`
    add(whole, runId, name)
    if (all(runId) || read.node(runId, name) === 'full') continue
    if (read.creatable(runId, name)) continue
    return `node:${tuple(runId, name)}`
  }
  // A child hangs on a node that is stored or that the mutation writes.
  const writable = (runId: string, nodeName: string, childKey: string) =>
    (whole.get(runId)?.has(nodeName) || read.stored(runId, nodeName)) &&
    (all(runId) ||
      read.child(runId, nodeName, childKey) ||
      read.complete(runId, nodeName) ||
      read.creatable(runId, nodeName))
  for (const { runId, nodeName, childKey } of mutation.children ?? []) {
    if (!writable(runId, nodeName, childKey)) {
      return `child:${tuple(runId, nodeName, childKey)}`
    }
  }
  for (const { runId, nodeName, childKey, id } of mutation.attempts ?? []) {
    if (all(runId)) continue
    const seen = read.attempt(runId, id)
    if (seen?.nodeName === nodeName && seen.childKey === childKey) continue
    if (!(minted(id) && writable(runId, nodeName, childKey))) {
      return `attempt:${tuple(runId, nodeName, childKey, id)}`
    }
  }
  return undefined
}

function add(names: Map<string, Set<string>>, runId: string, name: string) {
  const of = names.get(runId)
  if (of) of.add(name)
  else names.set(runId, new Set([name]))
}

/**
 * What a snapshot read of the runs a mutation writes into: looked up where
 * the snapshot holds it, and indexed only where a lookup would go through
 * many records, as the window of a map's children.
 */
class Coverage {
  readonly #snapshot: Snapshot
  // The keys of the children of a map read in a window, by run and node.
  readonly #windows = new Map<string, Map<string, Set<string>>>()
  // The attempts an open read found, by run and id.
  readonly #attempts = new Map<string, Map<string, StoredAttempt>>()

  constructor(snapshot: Snapshot) {
    this.#snapshot = snapshot
  }

  /** How a node was read: whole, without its input, or not at all. */
  node(runId: string, name: string): NodeRead['view'] | undefined {
    const { units, open, childResults } = this.#snapshot
    const of = ({ node }: { readonly node: StoredNode | undefined }) =>
      node?.runId === runId && node.name === name
    for (const unit of units.values()) if (of(unit)) return 'full'
    for (const results of childResults.values()) {
      if (of(results)) return 'full'
    }
    for (const { view, record } of open.get(runId)?.nodes ?? []) {
      if (record.name === name) return view
    }
    return undefined
  }

  /** Whether a node is stored as the snapshot shows it, a run whole too. */
  stored(runId: string, name: string) {
    return (
      this.node(runId, name) !== undefined ||
      this.#snapshot.runs
        .get(runId)
        ?.nodes.some((node) => node.name === name) === true
    )
  }

  /** A node an open read of its run did not find: it is absent. */
  creatable(runId: string, name: string) {
    return (
      this.#snapshot.open.get(runId) !== undefined &&
      this.node(runId, name) === undefined
    )
  }

  /** Whether every child of a node was read. */
  complete(runId: string, nodeName: string) {
    const { open, childResults } = this.#snapshot
    if (open.get(runId)?.childSets.get(nodeName)?.view === 'all') return true
    for (const { node } of childResults.values()) {
      if (node?.runId === runId && node.name === nodeName) return true
    }
    return false
  }

  /** Whether a child was read, by a unit or in a map's window. */
  child(runId: string, nodeName: string, childKey: string) {
    for (const { child } of this.#snapshot.units.values()) {
      if (
        child?.runId === runId &&
        child.nodeName === nodeName &&
        child.childKey === childKey
      ) {
        return true
      }
    }
    const set = this.#snapshot.open.get(runId)?.childSets.get(nodeName)
    if (set?.view !== 'map') return false
    let windows = this.#windows.get(runId)
    if (!windows) this.#windows.set(runId, (windows = new Map()))
    let keys = windows.get(nodeName)
    if (!keys) {
      keys = new Set()
      for (const { childKey: key } of set.active) keys.add(key)
      for (const { childKey: key } of set.pending) keys.add(key)
      windows.set(nodeName, keys)
    }
    return keys.has(childKey)
  }

  /** An attempt read of a run, by a unit or an open read. */
  attempt(runId: string, id: string): StoredAttempt | undefined {
    for (const { attempt } of this.#snapshot.units.values()) {
      if (attempt?.runId === runId && attempt.id === id) return attempt
    }
    const open = this.#snapshot.open.get(runId)
    if (!open) return undefined
    let attempts = this.#attempts.get(runId)
    if (!attempts) {
      attempts = new Map(open.attempts.map((record) => [record.id, record]))
      this.#attempts.set(runId, attempts)
    }
    return attempts.get(id)
  }
}

/**
 * What of a mutation no store can keep as given, or nothing: a child's
 * ordinal that is no integer, which a store orders children by. A defect of
 * the plan's, refused before anything is written.
 */
export function malformed(mutation: Mutation): string | undefined {
  for (const { runId, nodeName, childKey, ordinal } of mutation.children ??
    []) {
    if (ordinal !== undefined && !Number.isSafeInteger(ordinal)) {
      const named = JSON.stringify([runId, nodeName, childKey])
      return `Ordinal [${ordinal}] of child [${named}]`
    }
  }
  return undefined
}

export type Planned<A, E = never> =
  /** Load this too and plan again. */
  | { readonly _tag: 'Need'; readonly scope: ReadScope }
  | { readonly _tag: 'Commit'; readonly mutation: Mutation; readonly result: A }
  | { readonly _tag: 'Fail'; readonly error: E }

/**
 * A plan is pure: the store may call it again, with more loaded or after a
 * concurrent change, and only the mutation of its last call is applied.
 */
export type Plan<A, E = never> = (snapshot: Snapshot) => Planned<A, E>

/** The commands of one kind a worker has code for. */
export type Lane<K extends Command['kind'] = Command['kind']> = {
  readonly kind: K
  readonly routes: readonly Route[]
}

export type ClaimOptions<K extends Command['kind'] = Command['kind']> = {
  readonly lanes: readonly Lane<K>[]
  readonly limit: number
  /** How long the claim is held before the command is delivered again. */
  readonly leaseMs: number
}

export type ReleaseOptions = {
  /**
   * Why the delivery failed: kept as the command's last error, and the
   * delivery counts. Without one the delivery is not counted, so a command
   * given back by workers that stop never drifts toward being set aside.
   */
  readonly error?: unknown
  readonly delayMs?: number
}

export type RunFilter = {
  readonly kind?: RunKind
  readonly name?: string
  /** `null` selects unversioned runs only. */
  readonly revision?: string | null
  /** Any of these; none of them matches nothing. */
  readonly status?: readonly RunStatus[]
  /** `activeSince` earlier than this. */
  readonly activeBefore?: Timestamp
  /** `createdAt` earlier than this. */
  readonly createdBefore?: Timestamp
  /** `null` selects root runs only. */
  readonly parentRunId?: string | null
  readonly rootRunId?: string
  /** Every tag given, with its value. */
  readonly tags?: Readonly<Record<string, string>>
  /**
   * JSON containment, as PostgreSQL's `@>`: an object contains its subset of
   * fields, an array contains its subset of items in any order, a scalar its
   * equal.
   */
  readonly input?: unknown
}

/** A run as a list shows it: no payloads, and how far its nodes are. */
export type ListedRun = RunSummary & {
  readonly nodesTotal: number
  readonly nodesCompleted: number
  /** The child of its parent that started it. */
  readonly origin?: { readonly nodeName: string; readonly childKey: string }
}

/** One page of a list, and where the next begins when there is more. */
export type Page<A> = {
  readonly items: readonly A[]
  readonly next?: string
}

type Paging = {
  readonly limit: number
  /** The `next` of an earlier page of the same list. */
  readonly after?: string
}

/**
 * All an adapter provides: guarded all-or-nothing commits of planned
 * mutations, a command queue, and reads that find what plans then decide.
 * Every rule of the engine is in the plans.
 *
 * An adapter interprets no record. Its reads select by the fields their
 * queries name, and of what a status means it knows `STATUSES` of the model
 * and nothing more: which runs have ended, for `dead` and for families,
 * which nodes are done, for the counts of a list, and which children wait
 * or are under way, for the windows of an open read. Of a node's kind it
 * knows `MAPS`: whose children are read by window and whose input is not
 * read at all.
 *
 * An id, of a run or of a command, is the exact text the store gave: it is
 * compared as text and never read. The same id in another spelling, as a
 * uuid in capitals, names nothing, in every operation of every adapter: a
 * load finds no run, a claim under it is stale, a list by it is empty.
 *
 * `StorageError` is how every operation that touches storage says that the
 * storage failed it. Nothing of the operation was applied then, with one
 * exception: when it failed while its writes were being committed, all of
 * them were applied or none, and which is not known. That is so for
 * `transact`, and for `claim`, `release` and `renew`, each of which is one
 * write. Whoever asks again must therefore expect to find the work done: a
 * plan decides anew on what is stored, a command that was claimed after all
 * is delivered again when its lease ends, and a claim whose release or
 * acknowledgement went through is answered with `StaleClaim`. An adapter
 * fails with it instead of dying, and never for a mistake of the caller's:
 * a write to what a plan did not load is a defect.
 */
export class Store extends Context.Service<
  Store,
  {
    readonly transact: <A, E = never>(
      scope: ReadScope,
      plan: Plan<A, E>,
    ) => Effect.Effect<A, E | StaleClaim | StorageError>
    /**
     * Takes due commands of the given lanes, in the order they were queued
     * across all of them: a lane of many waiting commands starves no other.
     */
    readonly claim: <K extends Command['kind']>(
      options: ClaimOptions<K>,
    ) => Effect.Effect<
      readonly Claim<Extract<Command, { kind: K }>>[],
      StorageError
    >
    /** Gives a claimed command back for another delivery. */
    readonly release: (
      claim: Claim,
      options?: ReleaseOptions,
    ) => Effect.Effect<void, StaleClaim | StorageError>
    /**
     * Holds a claim for `leaseMs` more from now, and answers with the head of
     * the command's run as it is stored then. That is all a worker needs to
     * learn that the run no longer wants the work, at no more than the write
     * that keeps the claim.
     */
    readonly renew: (
      claim: Claim,
      leaseMs: number,
    ) => Effect.Effect<StoredRun | undefined, StaleClaim | StorageError>
    /**
     * Subscribes to hints that a command of one of `kinds` may have become
     * claimable. The effect it gives waits for the next hint; one that came
     * since the last wait is kept, so a hint during a claim is not missed.
     *
     * Only a hint: it may be missing or groundless, and a command that becomes
     * due later gives none. Polling `claim` is what finds work.
     */
    readonly hints: (
      kinds: readonly Command['kind'][],
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>
    /**
     * Subscribes to the hints of one topic a mutation may `notify`, as `hints`
     * does to those of commands, and as much only a hint.
     */
    readonly listen: (
      topic: string,
    ) => Effect.Effect<Effect.Effect<void>, never, Scope.Scope>
    readonly load: (
      runId: string,
    ) => Effect.Effect<RunRecords | undefined, StorageError>
    /**
     * The runs a filter selects, newest first: by `createdAt`, later created
     * first among equals. A read of its own moment, guarded by nothing: what
     * is done to a run found here is decided again in a plan.
     */
    readonly runs: (
      query: Paging & { readonly filter?: RunFilter },
    ) => Effect.Effect<Page<ListedRun>, StorageError>
    /**
     * Dead commands, the earliest set aside first. `id` selects one and
     * `runId` those of one run; `active` those whose run has not ended, which
     * are the only ones anything is left to do for.
     */
    readonly dead: (
      query: Paging & {
        readonly id?: string
        readonly runId?: string
        readonly active?: true
      },
    ) => Effect.Effect<Page<DeadCommand>, StorageError>
    /**
     * The runs among `runIds` that have a command under a claim whose lease
     * has not ended: a worker may be running work of theirs right now.
     */
    readonly claimed: (
      runIds: readonly string[],
    ) => Effect.Effect<readonly string[], StorageError>
    /**
     * Schedules in the order of their names, compared by code point. `due`
     * selects those that are enabled and whose `nextRunAt` is no later than
     * it. A read of its own moment: firing one is decided again in a plan.
     */
    readonly schedules: (
      query: Paging & { readonly due?: Timestamp },
    ) => Effect.Effect<Page<StoredSchedule>, StorageError>
    /**
     * The ids of the root runs in `status` whose `updatedAt` is earlier than
     * `updatedBefore`, the longest unchanged first. A read of its own moment,
     * and of roots alone: whether a family may go is decided in a plan that
     * loads it.
     */
    readonly prunable: (
      query: Paging & {
        readonly status: RunStatus
        readonly updatedBefore: Timestamp
      },
    ) => Effect.Effect<Page<string>, StorageError>
  }
>()('@nmtjs/workflows/Store') {}
