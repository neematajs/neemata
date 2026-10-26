import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Latch from 'effect/Latch'
import * as Layer from 'effect/Layer'

import type {
  Command,
  RunRecords,
  RunStatus,
  StoredAttempt,
  StoredChild,
  StoredError,
  StoredNode,
  StoredRun,
  StoredSchedule,
  Timestamp,
} from './model.ts'
import type {
  ChildResults,
  ChildSet,
  Claim,
  ClaimOptions,
  DeadCommand,
  Family,
  ListedRun,
  Mutation,
  NodeRead,
  NodeWithoutInput,
  OpenRecords,
  Page,
  Plan,
  ReadScope,
  ReleaseOptions,
  RunFilter,
  Snapshot,
  UnitRead,
  UnitRecords,
} from './store.ts'
import { StaleClaim } from './errors.ts'
import { byCodePoint, isMap, STATUSES, storedError } from './model.ts'
import {
  foundRuns,
  linking,
  malformed,
  opened,
  resultsKey,
  Store,
  unitKey,
  unloaded,
  widened,
} from './store.ts'

/** A command as the queue holds it. */
export type QueuedCommand = {
  readonly id: string
  readonly command: Command
  readonly dedupe: string
  readonly availableAt: Timestamp
  readonly deliveries: number
  readonly claim?: { readonly token: string; readonly expiresAt: Timestamp }
  readonly error?: StoredError
  readonly createdAt: Timestamp
  /** Set once the command was set aside, with its place among the dead. */
  readonly deadAt?: Timestamp
  readonly deadOrder?: number
}

export type InMemoryOptions = {
  /** A command claimed more often than this is set aside as dead. */
  readonly maxDeliveries?: number
  /**
   * Called with every planned mutation before it is checked and applied.
   * Throwing aborts the commit; changing the store makes the plan run again.
   * For tests: it is the gap a concurrent writer would act in.
   */
  readonly beforeCommit?: (mutation: Mutation) => void
}

/**
 * The children of a map waiting to start, by ordinal: the first few are
 * found without looking at the others, and one starting or coming back costs
 * the logarithm of how many wait. A heap whose entries a child's leaving
 * makes void, rather than removes: each is dropped once it comes to the top.
 */
class Waiting {
  // By key, with the entry of the heap that stands for each.
  readonly #children = new Map<string, { child: StoredChild; entry: number }>()
  readonly #heap: { readonly ordinal: number; readonly id: number }[] = []
  // The key an entry stands for, while it does.
  readonly #entries = new Map<number, string>()
  #next = 0

  set(child: StoredChild) {
    const held = this.#children.get(child.childKey)
    if (held && held.child.ordinal === child.ordinal) {
      held.child = child
      return
    }
    if (held) this.#entries.delete(held.entry)
    const id = this.#next++
    this.#children.set(child.childKey, { child, entry: id })
    this.#entries.set(id, child.childKey)
    this.#push({ ordinal: child.ordinal ?? 0, id })
  }

  delete(childKey: string) {
    const held = this.#children.get(childKey)
    if (!held) return
    this.#children.delete(childKey)
    this.#entries.delete(held.entry)
  }

  /** The first `count` by ordinal, the heap left as it was found. */
  first(count: number): StoredChild[] {
    const taken: { readonly ordinal: number; readonly id: number }[] = []
    const found: StoredChild[] = []
    while (found.length < count && this.#heap.length > 0) {
      const top = this.#pop()
      const key = this.#entries.get(top.id)
      // Void: its child left, or came back with another entry.
      if (key === undefined) continue
      taken.push(top)
      found.push(this.#children.get(key)!.child)
    }
    for (const entry of taken) this.#push(entry)
    return found
  }

  #push(entry: { readonly ordinal: number; readonly id: number }) {
    const heap = this.#heap
    heap.push(entry)
    for (let at = heap.length - 1; at > 0; ) {
      const parent = (at - 1) >> 1
      if (!before(heap[at]!, heap[parent]!)) break
      ;[heap[at], heap[parent]] = [heap[parent]!, heap[at]!]
      at = parent
    }
  }

  #pop() {
    const heap = this.#heap
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      for (let at = 0; ; ) {
        const left = 2 * at + 1
        const right = left + 1
        let least = at
        if (left < heap.length && before(heap[left]!, heap[least]!))
          least = left
        if (right < heap.length && before(heap[right]!, heap[least]!)) {
          least = right
        }
        if (least === at) break
        ;[heap[at], heap[least]] = [heap[least]!, heap[at]!]
        at = least
      }
    }
    return top
  }
}

// By ordinal, then by the order they were added, as one key of a child.
const before = (
  a: { readonly ordinal: number; readonly id: number },
  b: { readonly ordinal: number; readonly id: number },
) => (a.ordinal - b.ordinal || a.id - b.id) < 0

/** The children of one node, as an open read finds them. */
type Siblings = {
  /** Every child, by key. */
  readonly all: Map<string, StoredChild>
  /**
   * Of the items of a map, those under way, by key, and those waiting.
   * Made with the first item: no other node is read by window.
   */
  items?: {
    readonly active: Map<string, StoredChild>
    readonly pending: Waiting
  }
}

type Owned = {
  run: StoredRun
  /** The order runs were created in, which `createdAt` alone does not give. */
  readonly sequence: number
  /** By name. */
  readonly nodes: Map<string, StoredNode>
  /** By `ownedChild`. */
  readonly children: Map<string, StoredChild>
  /** By node name. */
  readonly siblings: Map<string, Siblings>
  /** By id. */
  readonly attempts: Map<string, StoredAttempt>
}

const byOrdinal = (a: StoredChild, b: StoredChild) =>
  (a.ordinal ?? 0) - (b.ordinal ?? 0)

/** Files a child written under its node: a map's by where it stands. */
function file(owner: Owned, child: StoredChild) {
  let siblings = owner.siblings.get(child.nodeName)
  if (!siblings) {
    siblings = { all: new Map() }
    owner.siblings.set(child.nodeName, siblings)
  }
  const { childKey, status, ordinal } = child
  siblings.all.set(childKey, child)
  // Only the items of a map are read by window.
  if (ordinal === undefined) return
  const items = (siblings.items ??= {
    active: new Map(),
    pending: new Waiting(),
  })
  if (status === STATUSES.pending) items.pending.set(child)
  else items.pending.delete(childKey)
  if ((STATUSES.active as readonly string[]).includes(status)) {
    items.active.set(childKey, child)
  } else items.active.delete(childKey)
}

function withoutInput(node: StoredNode): NodeWithoutInput {
  const { input: _, ...rest } = node
  return rest
}

// Not the two joined: a name or a key may hold whatever joins them.
const ownedChild = (nodeName: string, childKey: string) =>
  JSON.stringify([nodeName, childKey])

const runGuard = (runId: string) => `run:${runId}`
const keyGuard = (key: string) => `key:${key}`
const definitionGuard = (key: string) => `definition:${key}`
const scheduleGuard = (name: string) => `schedule:${name}`
/** Which schedules exist: moved when one is added or removed. */
const SCHEDULES = 'schedules'

const ended = (status: string) =>
  (STATUSES.terminal as readonly string[]).includes(status)

/** JSON containment, as PostgreSQL's `@>`. */
function contains(value: unknown, part: unknown): boolean {
  if (Array.isArray(part)) {
    return (
      Array.isArray(value) &&
      part.every((item) => value.some((held) => contains(held, item)))
    )
  }
  if (part !== null && typeof part === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    const fields = value as Record<string, unknown>
    return Object.entries(part).every(
      ([key, item]) =>
        Object.hasOwn(fields, key) && contains(fields[key], item),
    )
  }
  return value === part
}

function matches(run: StoredRun, filter: RunFilter) {
  const { revision, parentRunId, tags, input } = filter
  return (
    (filter.kind === undefined || run.kind === filter.kind) &&
    (filter.name === undefined || run.name === filter.name) &&
    (revision === undefined || run.revision === (revision ?? undefined)) &&
    (filter.status === undefined || filter.status.includes(run.status)) &&
    (filter.activeBefore === undefined ||
      run.activeSince < filter.activeBefore) &&
    (filter.createdBefore === undefined ||
      run.createdAt < filter.createdBefore) &&
    (parentRunId === undefined ||
      run.parentRunId === (parentRunId ?? undefined)) &&
    (filter.rootRunId === undefined || run.rootRunId === filter.rootRunId) &&
    (tags === undefined ||
      Object.entries(tags).every(([key, value]) => run.tags[key] === value)) &&
    (input === undefined || contains(run.input, input))
  )
}

type Paging = { readonly limit: number; readonly after?: string }

/** How a list places its items: the cursor of one, and what follows a cursor. */
type Placing<A> = {
  readonly cursor: (item: A) => string
  readonly follows: (item: A, after: string) => boolean
}

const numbered = <A>(place: (item: A) => number): Placing<A> => ({
  cursor: (item) => String(place(item)),
  follows: (item, after) => place(item) > Number(after),
})

/**
 * The items of an ordered list that come after the place a cursor names,
 * `limit` of them at most. A cursor is a place in the order, not an item: it
 * holds when the item it was taken from has left the list.
 */
function page<A>(
  ordered: readonly A[],
  { cursor, follows }: Placing<A>,
  { limit, after }: Paging,
): Page<A> {
  const rest =
    after === undefined
      ? ordered
      : ordered.filter((item) => follows(item, after))
  const items = rest.slice(0, Math.max(0, limit))
  return items.length > 0 && items.length < rest.length
    ? { items, next: cursor(items.at(-1)!) }
    : { items }
}

/** A command that was set aside, as the store shows it. */
function deadCommand(queued: QueuedCommand): DeadCommand {
  const { id, command, deliveries, error, createdAt } = queued
  return {
    id,
    command,
    deliveries,
    ...(error === undefined ? {} : { error }),
    createdAt,
    deadAt: queued.deadAt!,
  }
}

/** A unit, found by its keys alone: nothing else the run owns is read. */
function unitRecords(
  owner: Owned | undefined,
  { nodeName, childKey, attemptId }: UnitRead,
): UnitRecords {
  const child = owner?.children.get(ownedChild(nodeName, childKey))
  const id = attemptId ?? child?.currentAttemptId
  const attempt = id === undefined ? undefined : owner?.attempts.get(id)
  return {
    run: owner?.run,
    node: owner?.nodes.get(nodeName),
    child,
    attempt:
      attempt?.nodeName === nodeName && attempt.childKey === childKey
        ? attempt
        : undefined,
  }
}

/**
 * A run as a pass reads it: its nodes, a map's without its list, and of the
 * nodes that have not ended the children they wait on, found by node and by
 * where they stand, never by looking through the others.
 */
function openRecords(
  owner: Owned,
  maps: ReadonlyMap<string, number | 'all'>,
  /** How the runs of the children read are found, when they are read. */
  head: ((runId: string) => StoredRun | undefined) | undefined,
): OpenRecords {
  const nodes: NodeRead[] = []
  const childSets = new Map<string, ChildSet>()
  const attempts: StoredAttempt[] = []
  const linked = new Map<string, StoredRun | undefined>()
  const read = (children: readonly StoredChild[]) => {
    for (const child of children) {
      const { nodeName, childKey, currentAttemptId: id, childRunId } = child
      const attempt = id === undefined ? undefined : owner.attempts.get(id)
      if (attempt?.nodeName === nodeName && attempt.childKey === childKey) {
        attempts.push(attempt)
      }
      if (head && childRunId !== undefined && !ended(child.status)) {
        linked.set(childRunId, head(childRunId))
      }
    }
    return children
  }
  for (const node of owner.nodes.values()) {
    const mapped = isMap(node.kind)
    nodes.push(
      mapped
        ? { view: 'withoutInput', record: withoutInput(node) }
        : { view: 'full', record: node },
    )
    if (ended(node.status)) continue
    const siblings = owner.siblings.get(node.name)
    if (!mapped) {
      const children = read(Array.from(siblings?.all.values() ?? []))
      childSets.set(node.name, { view: 'all', children })
      continue
    }
    const pendingLimit = maps.get(node.name)
    if (pendingLimit === undefined) continue
    const items = siblings?.items
    const active = Array.from(items?.active.values() ?? []).sort(byOrdinal)
    const first =
      items?.pending.first(
        pendingLimit === 'all' ? Infinity : pendingLimit + 1,
      ) ?? []
    const pending = first.slice(
      0,
      pendingLimit === 'all' ? undefined : pendingLimit,
    )
    childSets.set(node.name, {
      view: 'map',
      active: read(active),
      pending: read(pending),
      pendingLimit,
      hasMore: first.length > pending.length,
    })
  }
  return { run: owner.run, nodes, childSets, attempts, linked }
}

/** A node with its input and every child, by ordinal. */
function childResults(
  owner: Owned | undefined,
  nodeName: string,
): ChildResults {
  const node = owner?.nodes.get(nodeName)
  const children = node
    ? Array.from(owner!.siblings.get(nodeName)?.all.values() ?? [])
    : []
  return { node, children: children.sort(byOrdinal) }
}

function records({ run, nodes, children, attempts }: Owned): RunRecords {
  return {
    run,
    nodes: Array.from(nodes.values()),
    children: Array.from(children.values()),
    attempts: Array.from(attempts.values()),
  }
}

/**
 * The reference store. JavaScript runs each `transact` to its end without
 * interleaving, yet it guards and validates as a concurrent store must: it is
 * what the engine's plans are specified against.
 */
export function makeInMemoryStore(options: InMemoryOptions = {}) {
  const maxDeliveries = options.maxDeliveries ?? 20
  const owned = new Map<string, Owned>()
  const keys = new Map<string, string>()
  const definitions = new Map<string, unknown>()
  const schedules = new Map<string, StoredSchedule>()
  // One revision per run, moved by any write to anything the run owns, one
  // per key, definition and schedule, and one for which schedules exist:
  // what a snapshot is compared against at commit. Families and dead
  // commands have none: what was read of them is compared instead.
  const revisions = new Map<string, number>()
  let created = 0
  // By id, in the order the commands were queued, which is the order they
  // are claimed in: a command claimed or given back keeps its place.
  const queue = new Map<string, QueuedCommand>()
  // Of each key, the commands that no claim holds: what a command queued
  // with the key finds waiting, without looking through the queue.
  const unclaimed = new Map<string, Set<QueuedCommand>>()
  let dead: QueuedCommand[] = []
  // One latch per subscription, open while a hint waits to be taken.
  const listeners = new Map<Latch.Latch, readonly Command['kind'][]>()
  const topics = new Map<Latch.Latch, string>()
  let nextId = 1

  const id = (prefix: string) => `${prefix}-${nextId++}`
  // The place of each command in the queue, as a number to compare.
  const places = new Map<string, number>()
  let queued = 0
  const unwait = (command: QueuedCommand) => {
    const waiting = unclaimed.get(command.dedupe)
    waiting?.delete(command)
    if (waiting?.size === 0) unclaimed.delete(command.dedupe)
  }
  /** Writes a command in its place, or at the end when it is new. */
  const put = (command: QueuedCommand) => {
    const before = queue.get(command.id)
    if (before) unwait(before)
    else places.set(command.id, queued++)
    queue.set(command.id, command)
    if (command.claim) return
    const waiting = unclaimed.get(command.dedupe)
    if (waiting) waiting.add(command)
    else unclaimed.set(command.dedupe, new Set([command]))
  }
  const take = (command: QueuedCommand) => {
    queue.delete(command.id)
    places.delete(command.id)
    unwait(command)
  }
  /** Of the commands of a key that no claim holds, the first queued. */
  const waitingWith = (dedupe: string) => {
    let first: QueuedCommand | undefined
    for (const command of unclaimed.get(dedupe) ?? []) {
      if (!first || places.get(command.id)! < places.get(first.id)!) {
        first = command
      }
    }
    return first
  }
  const revision = (guard: string) => revisions.get(guard) ?? 0
  const touch = (guard: string) => revisions.set(guard, revision(guard) + 1)
  const hint = (kind: Command['kind']) => {
    for (const [latch, kinds] of listeners) {
      if (kinds.includes(kind)) latch.openUnsafe()
    }
  }

  /** The runs with a command under a claim whose lease has not ended. */
  const claimedRuns = (now: Timestamp) => {
    const held = new Set<string>()
    for (const { command, claim } of queue.values()) {
      if (claim !== undefined && claim.expiresAt > now) held.add(command.runId)
    }
    return held
  }

  const under = (rootRunId: string) =>
    Array.from(owned.values()).filter(({ run }) => run.rootRunId === rootRunId)

  function family(rootRunId: string, now: Timestamp): Family | undefined {
    const root = owned.get(rootRunId)?.run
    if (!root) return undefined
    const { input: _, output: __, presentation: ___, ...summary } = root
    const members = under(rootRunId).map(({ run }) => run)
    const active = members.filter(({ status }) => !ended(status))
    const held = claimedRuns(now)
    const claimed = members.find(({ id }) => held.has(id))
    return {
      root: summary,
      size: members.length,
      active: active.length,
      ...(active[0] ? { activeRunId: active[0].id } : {}),
      ...(claimed ? { claimedRunId: claimed.id } : {}),
    }
  }

  function load(scope: ReadScope, now: Timestamp) {
    const guards = new Map<string, number>()
    const guard = (name: string) => guards.set(name, revision(name))

    const runs = new Map<string, RunRecords | undefined>()
    for (const runId of scope.runs ?? []) {
      guard(runGuard(runId))
      const found = owned.get(runId)
      runs.set(runId, found && records(found))
    }
    const heads = new Map<string, StoredRun | undefined>()
    for (const runId of scope.heads ?? []) {
      guard(runGuard(runId))
      heads.set(runId, owned.get(runId)?.run)
    }
    const units = new Map<string, UnitRecords>()
    for (const unit of scope.units ?? []) {
      guard(runGuard(unit.runId))
      units.set(unitKey(unit), unitRecords(owned.get(unit.runId), unit))
    }
    const open = new Map<string, OpenRecords | undefined>()
    const links = linking(scope)
    for (const [runId, maps] of opened(scope)) {
      guard(runGuard(runId))
      const found = owned.get(runId)
      const head = (id: string) => owned.get(id)?.run
      const records =
        found && openRecords(found, maps, links.has(runId) ? head : undefined)
      for (const id of records?.linked.keys() ?? []) guard(runGuard(id))
      open.set(runId, records)
    }
    const results = new Map<string, ChildResults>()
    for (const read of scope.childResults ?? []) {
      guard(runGuard(read.runId))
      results.set(
        resultsKey(read),
        childResults(owned.get(read.runId), read.nodeName),
      )
    }
    const held = new Map<string, string | undefined>()
    for (const key of scope.keys ?? []) {
      guard(keyGuard(key))
      held.set(key, keys.get(key))
    }

    const saved = new Map<string, unknown>()
    for (const key of scope.definitions ?? []) {
      guard(definitionGuard(key))
      saved.set(key, definitions.get(key))
    }

    const scheduled = new Map<string, StoredSchedule | undefined>()
    for (const name of scope.schedules ?? []) {
      guard(scheduleGuard(name))
      scheduled.set(name, schedules.get(name))
    }
    if (scope.scheduleNames) guard(SCHEDULES)
    const loaded = new Map<string, Family | undefined>()
    for (const rootRunId of scope.families ?? []) {
      guard(runGuard(rootRunId))
      loaded.set(rootRunId, family(rootRunId, now))
    }
    const set = new Map<string, DeadCommand | undefined>()
    for (const id of scope.dead ?? []) {
      const found = dead.find((queued) => queued.id === id)
      set.set(id, found && deadCommand(found))
    }

    const minted = new Set<string>()
    const snapshot: Snapshot = {
      now,
      id: (prefix) => {
        const made = id(prefix)
        minted.add(made)
        return made
      },
      runs,
      heads,
      units,
      open,
      childResults: results,
      keys: held,
      definitions: saved,
      schedules: scheduled,
      scheduleNames: scope.scheduleNames
        ? Array.from(schedules.keys())
        : undefined,
      families: loaded,
      dead: set,
    }
    return { snapshot, guards, minted }
  }

  /** Whether everything a snapshot was guarded by is as it was read. */
  function unchanged(
    { families, dead: set }: Snapshot,
    guards: ReadonlyMap<string, number>,
    now: Timestamp,
  ) {
    return (
      Array.from(guards).every(([name, seen]) => revision(name) === seen) &&
      // The runs under a root have guards of their own, which a family does
      // not take: its counts are compared instead.
      Array.from(families).every(([rootRunId, seen]) => {
        const stored = family(rootRunId, now)
        return stored?.size === seen?.size && stored?.active === seen?.active
      }) &&
      // A dead command never changes, and its id is never used again: that
      // it is there, or is not, is all there is to compare.
      Array.from(set).every(
        ([id, seen]) =>
          dead.some((queued) => queued.id === id) === (seen !== undefined),
      )
    )
  }

  function holds({ id, token }: Claim, now: Timestamp) {
    const queued = queue.get(id)
    return queued?.claim?.token === token && queued.claim.expiresAt > now
  }

  /** Checks everything, then writes everything: no check follows a write. */
  function commit(
    mutation: Mutation,
    scope: ReadScope,
    { snapshot, guards, minted }: ReturnType<typeof load>,
    now: Timestamp,
  ) {
    for (const claim of [...(mutation.ack ?? []), ...(mutation.hold ?? [])]) {
      if (!holds(claim, now)) return new StaleClaim({ commandId: claim.id })
    }
    // What a plan writes it must have read: an unguarded write could
    // overwrite a change the plan never saw.
    const guarded = (name: string) => {
      if (!guards.has(name)) throw new Error(`Unguarded write to [${name}]`)
    }
    const roots = new Set(mutation.remove)
    const removed = new Set<string>()
    for (const rootRunId of roots) {
      if (!scope.families?.includes(rootRunId)) {
        throw new Error(`Unguarded removal of family [${rootRunId}]`)
      }
      for (const { run } of under(rootRunId)) removed.add(run.id)
    }
    // A plan removes a family or writes to it, never both.
    const written = (runId: string, rootRunId: string) => {
      if (roots.has(rootRunId)) {
        throw new Error(`Write to run [${runId}] of a removed family`)
      }
    }
    const fresh = new Set<string>()
    let found: ReadonlySet<string> | undefined
    for (const run of mutation.runs ?? []) {
      written(run.id, run.rootRunId)
      if (!owned.has(run.id)) fresh.add(run.id)
      // Written over, a run is one the plan read: a family's root is
      // guarded by a read that does not show it.
      else if ((found ??= foundRuns(snapshot)).has(run.id)) {
        guarded(runGuard(run.id))
      } else throw new Error(`Unguarded write to [${runGuard(run.id)}]`)
    }
    // What a run owns is written to a run the plan loaded, which is there,
    // or to one the same mutation creates.
    for (const { runId } of [
      ...(mutation.nodes ?? []),
      ...(mutation.nodesPreservingInput ?? []),
      ...(mutation.children ?? []),
      ...(mutation.attempts ?? []),
    ]) {
      if (fresh.has(runId)) continue
      guarded(runGuard(runId))
      const owner = owned.get(runId)
      if (!owner) throw new Error(`Run [${runId}] does not exist`)
      written(runId, owner.run.rootRunId)
    }
    // Written but for its input, a node is one that is stored.
    for (const { runId, name } of mutation.nodesPreservingInput ?? []) {
      if (!owned.get(runId)?.nodes.has(name)) {
        throw new Error(`Node [${name}] of run [${runId}] does not exist`)
      }
    }
    // Of what it owns, only what the plan read: a guard is not a view.
    const unread = unloaded(snapshot, mutation, (made) => minted.has(made))
    if (unread !== undefined) throw new Error(`Unguarded write to [${unread}]`)
    const wrong = malformed(mutation)
    if (wrong !== undefined) throw new Error(wrong)
    for (const { name } of mutation.schedules ?? []) {
      guarded(scheduleGuard(name))
      if (!schedules.has(name)) guarded(SCHEDULES)
    }
    for (const name of mutation.unschedule ?? []) {
      guarded(scheduleGuard(name))
      guarded(SCHEDULES)
    }
    for (const { key } of mutation.keys ?? []) guarded(keyGuard(key))
    for (const { key } of mutation.definitions ?? []) {
      guarded(definitionGuard(key))
      // Guarded, so the plan saw this record and chose to write over it.
      if (definitions.has(key)) {
        throw new Error(`Definition [${key}] is already saved`)
      }
    }

    for (const runId of removed) {
      owned.delete(runId)
      touch(runGuard(runId))
    }
    for (const [key, runId] of keys) {
      if (removed.has(runId)) {
        keys.delete(key)
        touch(keyGuard(key))
      }
    }
    const left = ({ command }: QueuedCommand) => !removed.has(command.runId)
    if (removed.size > 0) {
      for (const queued of queue.values()) if (!left(queued)) take(queued)
      dead = dead.filter(left)
    }

    for (const run of mutation.runs ?? []) {
      const existing = owned.get(run.id)
      if (existing) existing.run = run
      else {
        owned.set(run.id, {
          run,
          sequence: created++,
          nodes: new Map(),
          children: new Map(),
          siblings: new Map(),
          attempts: new Map(),
        })
      }
      touch(runGuard(run.id))
    }
    for (const node of mutation.nodes ?? []) {
      owned.get(node.runId)!.nodes.set(node.name, node)
      touch(runGuard(node.runId))
    }
    for (const node of mutation.nodesPreservingInput ?? []) {
      const { nodes } = owned.get(node.runId)!
      const stored = nodes.get(node.name)!
      nodes.set(
        node.name,
        Object.hasOwn(stored, 'input')
          ? { ...node, input: stored.input }
          : node,
      )
      touch(runGuard(node.runId))
    }
    for (const child of mutation.children ?? []) {
      const key = ownedChild(child.nodeName, child.childKey)
      const owner = owned.get(child.runId)!
      owner.children.set(key, child)
      file(owner, child)
      touch(runGuard(child.runId))
    }
    for (const attempt of mutation.attempts ?? []) {
      owned.get(attempt.runId)!.attempts.set(attempt.id, attempt)
      touch(runGuard(attempt.runId))
    }
    for (const { op, key, runId } of mutation.keys ?? []) {
      if (op === 'acquire') keys.set(key, runId)
      else keys.delete(key)
      touch(keyGuard(key))
    }
    for (const { key, value } of mutation.definitions ?? []) {
      definitions.set(key, value)
      touch(definitionGuard(key))
    }
    for (const schedule of mutation.schedules ?? []) {
      if (!schedules.has(schedule.name)) touch(SCHEDULES)
      schedules.set(schedule.name, schedule)
      touch(scheduleGuard(schedule.name))
    }
    for (const name of mutation.unschedule ?? []) {
      if (schedules.delete(name)) touch(SCHEDULES)
      touch(scheduleGuard(name))
    }

    for (const { id } of mutation.ack ?? []) {
      const acked = queue.get(id)
      if (acked) take(acked)
    }
    for (const { command, dedupe, availableAt = now } of mutation.enqueue ??
      []) {
      if (dead.length > 0)
        dead = dead.filter((queued) => queued.dedupe !== dedupe)
      const waiting = waitingWith(dedupe)
      if (waiting) {
        // The wake that waits must not come later than the one asked for.
        if (availableAt < waiting.availableAt) {
          put({ ...waiting, availableAt })
          if (availableAt <= now) hint(waiting.command.kind)
        }
        continue
      }
      put({
        id: id('command'),
        command,
        dedupe,
        availableAt,
        deliveries: 0,
        createdAt: now,
      })
      if (availableAt <= now) hint(command.kind)
    }
    for (const [latch, topic] of topics) {
      if (mutation.notify?.includes(topic)) latch.openUnsafe()
    }
    return undefined
  }

  const transact = <A, E = never>(
    initial: ReadScope,
    plan: Plan<A, E>,
  ): Effect.Effect<A, E | StaleClaim> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.suspend((): Effect.Effect<A, E | StaleClaim> => {
        let scope = initial
        for (;;) {
          const loaded = load(scope, now)
          const { snapshot, guards } = loaded
          const planned = plan(snapshot)
          if (planned._tag === 'Fail') return Effect.fail(planned.error)
          if (planned._tag === 'Need') {
            scope = widened(scope, planned.scope)
            continue
          }

          options.beforeCommit?.(planned.mutation)
          // Something read has changed: the plan is void, so plan again.
          if (!unchanged(snapshot, guards, now)) continue

          const stale = commit(planned.mutation, scope, loaded, now)
          return stale ? Effect.fail(stale) : Effect.succeed(planned.result)
        }
      }),
    )

  const claim = <K extends Command['kind']>(request: ClaimOptions<K>) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const { lanes, limit, leaseMs } = request
      const claims: Claim<Extract<Command, { kind: K }>>[] = []
      const serves = ({ kind, name, revision }: Command) =>
        lanes.some(
          (lane) =>
            lane.kind === kind &&
            lane.routes.some(
              (route) => route.name === name && route.revision === revision,
            ),
        )

      // Changing an entry keeps its place, and one removed is not visited.
      for (const queued of queue.values()) {
        if (claims.length >= limit) break
        const { command } = queued
        const due =
          queued.availableAt <= now &&
          (!queued.claim || queued.claim.expiresAt <= now)
        if (!due || !serves(command)) continue
        if (queued.deliveries >= maxDeliveries) {
          const { claim: _claim, ...unclaimed } = queued
          take(queued)
          dead.push({ ...unclaimed, deadAt: now, deadOrder: nextId++ })
          continue
        }

        const token = id('claim')
        const deliveries = queued.deliveries + 1
        claims.push({
          id: queued.id,
          token,
          command: command as Extract<Command, { kind: K }>,
          deliveries,
          createdAt: queued.createdAt,
          availableAt: queued.availableAt,
          claimedAt: now,
        })
        put({
          ...queued,
          deliveries,
          claim: { token, expiresAt: now + leaseMs },
        })
      }

      return claims
    })

  const release = (
    released: Claim,
    { error, delayMs = 0 }: ReleaseOptions = {},
  ) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (!holds(released, now)) {
        return Effect.fail(new StaleClaim({ commandId: released.id }))
      }
      const queued = queue.get(released.id)!
      const { claim: _claim, ...unclaimed } = queued
      put(
        error === undefined
          ? {
              ...unclaimed,
              availableAt: now + delayMs,
              deliveries: queued.deliveries - 1,
            }
          : {
              ...unclaimed,
              availableAt: now + delayMs,
              error: storedError(error),
            },
      )
      if (delayMs <= 0) hint(released.command.kind)
      return Effect.void
    })

  const renew = (renewed: Claim, leaseMs: number) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      if (!holds(renewed, now)) {
        return Effect.fail(new StaleClaim({ commandId: renewed.id }))
      }
      put({
        ...queue.get(renewed.id)!,
        claim: { token: renewed.token, expiresAt: now + leaseMs },
      })
      return Effect.succeed(owned.get(renewed.command.runId)?.run)
    })

  /** Waits for a latch to open and closes it: the hint is taken. */
  const taking = (latch: Latch.Latch) =>
    Effect.andThen(
      latch.await,
      Effect.sync(() => {
        latch.closeUnsafe()
      }),
    )

  const hints = (kinds: readonly Command['kind'][]) =>
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const latch = Latch.makeUnsafe()
          listeners.set(latch, kinds)
          return latch
        }),
        (latch) => Effect.sync(() => listeners.delete(latch)),
      ),
      taking,
    )

  const listen = (topic: string) =>
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const latch = Latch.makeUnsafe()
          topics.set(latch, topic)
          return latch
        }),
        (latch) => Effect.sync(() => topics.delete(latch)),
      ),
      taking,
    )

  const load_ = (runId: string) =>
    Effect.sync(() => {
      const found = owned.get(runId)
      return found && records(found)
    })

  const runs = ({
    filter = {},
    ...paging
  }: {
    readonly filter?: RunFilter
    readonly limit: number
    readonly after?: string
  }) =>
    Effect.sync((): Page<ListedRun> => {
      const origins = new Map<string, ListedRun['origin']>()
      for (const { children } of owned.values()) {
        for (const { childRunId, nodeName, childKey } of children.values()) {
          if (childRunId !== undefined) {
            origins.set(childRunId, { nodeName, childKey })
          }
        }
      }
      // Runs are created in the order of the store's clock, so the order of
      // creation is that of `createdAt` with its ties broken.
      const places = new Map<string, number>()
      const newest = Array.from(owned.values())
        .filter(({ run }) => matches(run, filter))
        .sort((a, b) => b.sequence - a.sequence)
        .map(({ run, nodes, sequence }): ListedRun => {
          places.set(run.id, -sequence)
          const { input: _, output: __, presentation: ___, ...summary } = run
          const origin = origins.get(run.id)
          const completed = Array.from(nodes.values()).filter(
            ({ status }) => status === STATUSES.completed,
          )
          return {
            ...summary,
            nodesTotal: nodes.size,
            nodesCompleted: completed.length,
            ...(origin === undefined ? {} : { origin }),
          }
        })
      return page(
        newest,
        numbered(({ id }) => places.get(id)!),
        paging,
      )
    })

  const dead_ = ({
    id,
    runId,
    active,
    ...paging
  }: {
    readonly id?: string
    readonly runId?: string
    readonly active?: true
    readonly limit: number
    readonly after?: string
  }) =>
    Effect.sync((): Page<DeadCommand> => {
      const over = (id: string) => {
        const run = owned.get(id)?.run
        return !run || ended(run.status)
      }
      const places = new Map<string, number>()
      // Set aside in this order: the list is the earliest first already.
      const selected = dead
        .filter(
          (queued) =>
            (id === undefined || queued.id === id) &&
            (runId === undefined || queued.command.runId === runId) &&
            !(active && over(queued.command.runId)),
        )
        .map((queued) => {
          places.set(queued.id, queued.deadOrder!)
          return deadCommand(queued)
        })
      return page(
        selected,
        numbered(({ id }) => places.get(id)!),
        paging,
      )
    })

  const claimed = (runIds: readonly string[]) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      const held = claimedRuns(now)
      return runIds.filter((runId) => held.has(runId))
    })

  const schedules_ = ({
    due,
    ...paging
  }: Paging & { readonly due?: Timestamp }) =>
    Effect.sync(() =>
      page(
        Array.from(schedules.values())
          .filter(
            ({ enabled, nextRunAt }) =>
              due === undefined || (enabled && nextRunAt <= due),
          )
          .sort((a, b) => byCodePoint(a.name, b.name)),
        {
          cursor: ({ name }) => name,
          follows: ({ name }, after) => byCodePoint(name, after) > 0,
        },
        paging,
      ),
    )

  const prunable = ({
    status,
    updatedBefore,
    ...paging
  }: Paging & {
    readonly status: RunStatus
    readonly updatedBefore: Timestamp
  }) =>
    Effect.sync((): Page<string> => {
      // Among roots unchanged for equally long, the earlier created first.
      const place = ({ run, sequence }: Owned) =>
        [run.updatedAt, sequence] as const
      const roots = Array.from(owned.values())
        .filter(
          ({ run }) =>
            run.parentRunId === undefined &&
            run.status === status &&
            run.updatedAt < updatedBefore,
        )
        .sort((a, b) => place(a)[0] - place(b)[0] || a.sequence - b.sequence)
      const { items, next } = page(
        roots,
        {
          cursor: (root) => place(root).join(':'),
          follows: (root, after) => {
            const [updatedAt, sequence] = after.split(':').map(Number)
            const [at, order] = place(root)
            return at > updatedAt! || (at === updatedAt && order > sequence!)
          },
        },
        paging,
      )
      return {
        items: items.map(({ run }) => run.id),
        ...(next === undefined ? {} : { next }),
      }
    })

  return {
    store: Store.of({
      transact,
      claim,
      release,
      renew,
      hints,
      listen,
      load: load_,
      runs,
      dead: dead_,
      claimed,
      schedules: schedules_,
      prunable,
    }),
    /** The store's contents, for tests to assert on. */
    inspect: {
      queue: (): readonly QueuedCommand[] => Array.from(queue.values()),
      dead: (): readonly QueuedCommand[] => dead,
      keys: (): ReadonlyMap<string, string> => keys,
      definitions: (): ReadonlyMap<string, unknown> => definitions,
      schedules: (): ReadonlyMap<string, StoredSchedule> => schedules,
      runs: (): readonly RunRecords[] => Array.from(owned.values(), records),
    },
  }
}

export type InMemoryStore = ReturnType<typeof makeInMemoryStore>

export function layer(options?: InMemoryOptions): Layer.Layer<Store> {
  return Layer.sync(Store, () => makeInMemoryStore(options).store)
}
