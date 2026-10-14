import type {
  Command,
  DefinitionRecord,
  RunRecords,
  StoredAttempt,
  StoredChild,
  StoredNode,
  StoredRun,
  StoredSchedule,
  Timestamp,
} from '../model.ts'
import type {
  Claim,
  DeadCommand,
  Enqueue,
  Family,
  KeyChange,
  Mutation,
  NodeRead,
  NodeWithoutInput,
  Plan,
  ReadScope,
  Snapshot,
  UnitRead,
  UnitRecords,
} from '../store.ts'
import { isTerminal, STATUSES } from '../model.ts'

/** Thrown inside a plan that needs more loaded; `planning` turns it into `Need`. */
class NeedMore {
  constructor(readonly scope: ReadScope) {}
}

/**
 * Thrown inside a plan to answer without writing: whatever the plan drafted
 * so far is dropped, and `result` is what it answers.
 */
export class Unwritten<A> {
  constructor(readonly result: A) {}
}

/** Returned by a plan body to refuse the operation with a typed error. */
export class Refused<E> {
  // Nominal: a result that happens to carry an `error` is not a refusal.
  declare private readonly refused: true

  constructor(readonly error: E) {}
}

type Created<Record, Defaulted extends keyof Record> = Omit<
  Record,
  Defaulted | 'version' | 'createdAt' | 'updatedAt'
> &
  Partial<Pick<Record, Defaulted>>

/**
 * Hinted when a run is asked to stop or has ended: a worker running work of
 * the run looks at it at once, instead of at its next heartbeat.
 */
export const stopTopic = (runId: string) => `stop:${runId}`

/** Hinted when anything of a run, or of a run under the same root, changed. */
export const familyTopic = (rootRunId: string) => `family:${rootRunId}`

// Not their parts joined: a name or a key may hold whatever joins them, and
// two records would then be one.
const nodeKey = (runId: string, name: string) => JSON.stringify([runId, name])
const childKey = (runId: string, nodeName: string, key: string) =>
  JSON.stringify([runId, nodeName, key])
const attemptKey = (runId: string, nodeName: string, key: string, id: string) =>
  JSON.stringify([runId, nodeName, key, id])

/** What one run owns, each record under the key the draft knows it by. */
type Owned = {
  readonly nodes: Map<string, NodeRead>
  readonly children: Map<string, StoredChild>
  readonly attempts: Map<string, StoredAttempt>
}

/** How far the children of a map were read, when not all of them were. */
type Window = {
  readonly pendingLimit: number | 'all'
  readonly hasMore: boolean
}

/**
 * The work of a map node as the plan's writes left it: every child under
 * way, and those waiting by ordinal, as far as they were read.
 */
export type MapWork = Window & {
  readonly active: readonly StoredChild[]
  readonly pending: readonly StoredChild[]
}

/** A node with its input and every child, by ordinal. */
export type NodeResults = {
  readonly node: StoredNode
  readonly children: readonly StoredChild[]
}

const byOrdinal = (a: StoredChild, b: StoredChild) =>
  (a.ordinal ?? 0) - (b.ordinal ?? 0)

const exceeds = (limit: number | 'all', read: number | 'all') =>
  read !== 'all' && (limit === 'all' || limit > read)

/** A node without its input, whichever view it was read in. */
function withoutInput(record: NodeWithoutInput): NodeWithoutInput {
  const { input: _, ...rest } = record as NodeWithoutInput & {
    readonly input?: unknown
  }
  return rest
}

/**
 * A plan's working copy of what was loaded. Reads see the plan's own writes;
 * nothing leaves it but the mutation, so a plan stays a pure function of its
 * snapshot however many records it touches.
 */
export class Draft {
  readonly now: Timestamp
  readonly id: (prefix: string) => string
  readonly #snapshot: Snapshot
  readonly #runs = new Map<string, StoredRun>()
  readonly #nodes = new Map<string, NodeRead>()
  readonly #children = new Map<string, StoredChild>()
  readonly #attempts = new Map<string, StoredAttempt>()
  // The same records by the run that owns them, so that reading what one run
  // owns costs what that run holds and not what the plan has loaded: a run
  // that stops a thousand children reads each of them once.
  readonly #owned = new Map<string, Owned>()
  // Children by their node, by key: a map's work costs the children read
  // of it, not those of the run.
  readonly #byNode = new Map<string, Map<string, StoredChild>>()
  // Records are written whole, so one entry per record is the last version.
  // A node is written whole or but for its input, never both.
  readonly #written = {
    runs: new Set<string>(),
    nodes: new Set<string>(),
    preserving: new Set<string>(),
    children: new Set<string>(),
    attempts: new Set<string>(),
  }
  // Runs the plan made. Like a run loaded whole, and unlike one whose record
  // alone was loaded and then written, all that such a run owns is here.
  readonly #created = new Set<string>()
  // Nodes the plan made, where none was: all their children are its own.
  readonly #createdNodes = new Set<string>()
  // Runs opened: every node of theirs is here, and a node that is not is
  // absent.
  readonly #listed = new Set<string>()
  // How far the children of a node of a run not loaded whole were read:
  // all of them, or a map's window.
  readonly #read = new Map<string, 'all' | Window>()
  // What units and open reads loaded, found or absent, of runs not loaded
  // whole: a record that is not in the maps above is absent only when it is
  // in these.
  readonly #seen = {
    heads: new Set<string>(),
    nodes: new Set<string>(),
    children: new Set<string>(),
    attempts: new Set<string>(),
    // Attempts a unit read under its child, by `attemptKey`: one it did not
    // find there may be stored under another.
    underChild: new Set<string>(),
  }
  // Ids the snapshot gave this plan, which name nothing stored.
  readonly #minted = new Set<string>()
  readonly #keys: KeyChange[] = []
  readonly #definitions = new Map<string, DefinitionRecord>()
  // `undefined` is a schedule the plan removed.
  readonly #schedules = new Map<string, StoredSchedule | undefined>()
  readonly #removed = new Set<string>()
  readonly #enqueue: Enqueue[] = []
  readonly #ack: Claim[] = []
  readonly #hold: Claim[] = []

  constructor(snapshot: Snapshot) {
    this.#snapshot = snapshot
    this.now = snapshot.now
    this.id = (prefix) => {
      const id = snapshot.id(prefix)
      this.#minted.add(id)
      return id
    }

    // A node read whole by one read and without its input by another is
    // known whole.
    const node = (read: NodeRead) => {
      const { runId, name } = read.record
      if (this.#nodes.get(nodeKey(runId, name))?.view !== 'full') {
        this.#setNode(read)
      }
    }
    for (const [id, run] of snapshot.heads) {
      this.#seen.heads.add(id)
      if (run) this.#runs.set(id, run)
    }
    for (const [key, { run, node: found, child, attempt }] of snapshot.units) {
      // The key is the read, and what the read found may be nothing.
      const [runId, nodeName, ofChild, named] = JSON.parse(key) as string[]
      this.#seen.heads.add(runId!)
      this.#seen.nodes.add(nodeKey(runId!, nodeName!))
      this.#seen.children.add(childKey(runId!, nodeName!, ofChild!))
      // The attempt read is the named one, or the current one of the child
      // it found.
      const read = named ?? child?.currentAttemptId
      if (read !== undefined) {
        this.#seen.underChild.add(attemptKey(runId!, nodeName!, ofChild!, read))
      }
      if (run) this.#runs.set(run.id, run)
      if (found) node({ view: 'full', record: found })
      if (child) this.#setChild(child)
      if (attempt) this.#setAttempt(attempt)
    }
    for (const [runId, records] of snapshot.open) {
      this.#seen.heads.add(runId)
      if (!records) continue
      this.#listed.add(runId)
      this.#runs.set(runId, records.run)
      for (const read of records.nodes) node(read)
      for (const [name, set] of records.childSets) {
        const children =
          set.view === 'all' ? set.children : [...set.active, ...set.pending]
        this.#read.set(
          nodeKey(runId, name),
          set.view === 'all'
            ? 'all'
            : { pendingLimit: set.pendingLimit, hasMore: set.hasMore },
        )
        for (const child of children) {
          this.#setChild(child)
          // Its current attempt was read with it, found or not.
          if (child.currentAttemptId !== undefined) {
            this.#seen.attempts.add(child.currentAttemptId)
          }
        }
      }
      for (const attempt of records.attempts) this.#setAttempt(attempt)
      for (const [id, run] of records.linked) {
        this.#seen.heads.add(id)
        if (run) this.#runs.set(id, run)
      }
    }
    for (const [key, { node: found, children }] of snapshot.childResults) {
      const [runId, nodeName] = JSON.parse(key) as string[]
      this.#seen.nodes.add(nodeKey(runId!, nodeName!))
      if (!found) continue
      node({ view: 'full', record: found })
      this.#read.set(nodeKey(runId!, nodeName!), 'all')
      for (const child of children) this.#setChild(child)
    }
    for (const records of snapshot.runs.values()) {
      if (!records) continue
      const { run, nodes, children, attempts } = records
      this.#runs.set(run.id, run)
      for (const record of nodes) node({ view: 'full', record })
      for (const child of children) this.#setChild(child)
      for (const attempt of attempts) this.#setAttempt(attempt)
    }
  }

  /** A run with everything it owns; `undefined` when no such run exists. */
  records(runId: string): RunRecords | undefined {
    if (!this.#whole(runId)) throw new NeedMore({ runs: [runId] })
    const run = this.#runs.get(runId)
    if (!run) return undefined

    const { nodes, children, attempts } = this.#own(runId)
    return {
      run,
      nodes: Array.from(nodes.values(), (read) => this.#full(read)),
      children: Array.from(children.values()),
      attempts: Array.from(attempts.values()),
    }
  }

  /** A run record alone; `undefined` when no such run exists. */
  head(runId: string): StoredRun | undefined {
    const run = this.#runs.get(runId)
    if (run) return run
    if (this.#whole(runId) || this.#seen.heads.has(runId)) return undefined
    throw new NeedMore({ heads: [runId] })
  }

  /**
   * A unit of work as the plan's writes left it, each record `undefined`
   * when absent: an attempt is the unit's only under the child it names.
   * Each record is known from whatever read or made it, which need not be
   * this unit's read: an attempt the plan made, or one a child points to
   * since the plan moved it, is read as the unit's attempt.
   */
  unit(read: UnitRead): UnitRecords {
    const { runId, nodeName, childKey: key, attemptId } = read
    const atNode = nodeKey(runId, nodeName)
    const at = childKey(runId, nodeName, key)
    const node = this.#nodes.get(atNode)
    if (
      !this.#whole(runId) &&
      ((!this.#runs.has(runId) && !this.#seen.heads.has(runId)) ||
        // Read without its input, a node is not the unit's, which is whole.
        (node
          ? node.view !== 'full'
          : !this.#seen.nodes.has(atNode) && !this.#listed.has(runId)) ||
        (!this.#children.has(at) &&
          !this.#seen.children.has(at) &&
          !this.#everyChild(runId, nodeName)))
    ) {
      throw new NeedMore({ units: [read] })
    }
    const child = this.#children.get(at)
    const id = attemptId ?? child?.currentAttemptId
    return {
      run: this.#runs.get(runId),
      node: node && this.#full(node),
      child,
      attempt: id === undefined ? undefined : this.#unitAttempt(read, id),
    }
  }

  /**
   * The attempt of a unit, by the id it resolved to: absent when stored
   * under another child. One not known here is asked for by that id, as the
   * child's current one may since be another than the store holds.
   */
  #unitAttempt(read: UnitRead, id: string): StoredAttempt | undefined {
    const { runId, nodeName, childKey: key } = read
    const found = this.#attempts.get(id)
    if (found) {
      const mine =
        found.runId === runId &&
        found.nodeName === nodeName &&
        found.childKey === key
      return mine ? found : undefined
    }
    if (
      this.#whole(runId) ||
      this.#seen.attempts.has(id) ||
      this.#seen.underChild.has(attemptKey(runId, nodeName, key, id))
    ) {
      return undefined
    }
    throw new NeedMore({
      units: [{ runId, nodeName, childKey: key, attemptId: id }],
    })
  }

  /**
   * Has several records loaded at once. A plan that reads the runs of a
   * fan-out one by one is planned again for each; one that asks first, once.
   */
  require(
    scope: Pick<ReadScope, 'runs' | 'heads' | 'definitions' | 'schedules'>,
  ) {
    const loaded = this.#snapshot
    const runs = (scope.runs ?? []).filter((id) => !this.#whole(id))
    const heads = (scope.heads ?? []).filter(
      (id) =>
        !this.#runs.has(id) && !this.#whole(id) && !this.#seen.heads.has(id),
    )
    const definitions = (scope.definitions ?? []).filter(
      (key) => !loaded.definitions.has(key),
    )
    const schedules = (scope.schedules ?? []).filter(
      (name) => !loaded.schedules.has(name),
    )
    if (
      runs.length > 0 ||
      heads.length > 0 ||
      definitions.length > 0 ||
      schedules.length > 0
    ) {
      throw new NeedMore({ runs, heads, definitions, schedules })
    }
  }

  /** A schedule by name; `undefined` when no such schedule exists. */
  schedule(name: string): StoredSchedule | undefined {
    if (this.#schedules.has(name)) return this.#schedules.get(name)
    const { schedules } = this.#snapshot
    if (!schedules.has(name)) throw new NeedMore({ schedules: [name] })
    return schedules.get(name)
  }

  /** The names of all schedules, as they were when the plan began. */
  scheduleNames(): readonly string[] {
    const { scheduleNames } = this.#snapshot
    if (!scheduleNames) throw new NeedMore({ scheduleNames: true })
    return scheduleNames
  }

  /** A root run's family; `undefined` when no run has the id. */
  family(rootRunId: string): Family | undefined {
    const { families } = this.#snapshot
    if (!families.has(rootRunId)) throw new NeedMore({ families: [rootRunId] })
    return families.get(rootRunId)
  }

  /** A dead command by id; `undefined` when none has it. */
  dead(id: string): DeadCommand | undefined {
    const { dead } = this.#snapshot
    if (!dead.has(id)) throw new NeedMore({ dead: [id] })
    return dead.get(id)
  }

  /** Removes a family whole. Nothing of it is written in the same plan. */
  remove(family: Family) {
    this.#removed.add(family.root.id)
  }

  /** The value saved under a definition key; `undefined` when none is. */
  definition(key: string): unknown {
    const { definitions } = this.#snapshot
    if (!definitions.has(key)) throw new NeedMore({ definitions: [key] })
    return this.#definitions.get(key)?.value ?? definitions.get(key)
  }

  /** Saves a record under a key that holds none. */
  save(record: DefinitionRecord) {
    this.#definitions.set(record.key, record)
  }

  /** The run holding an identity key, if any. */
  holder(key: string): string | undefined {
    if (!this.#snapshot.keys.has(key)) throw new NeedMore({ keys: [key] })
    const change = this.#keys.findLast((change) => change.key === key)
    if (change) return change.op === 'acquire' ? change.runId : undefined
    return this.#snapshot.keys.get(key)
  }

  // A record that is not here is absent only where the plan read: what it
  // did not read may well be stored.

  /**
   * Every node of a run, each as it was read: a map's may lack its input,
   * which is not to say it has none. Of a run opened, or loaded whole.
   */
  nodes(runId: string): readonly NodeWithoutInput[] {
    if (!this.#whole(runId) && !this.#listed.has(runId)) {
      throw new NeedMore({ open: [{ runId, maps: [] }] })
    }
    return Array.from(this.#own(runId).nodes.values(), ({ record }) => record)
  }

  /** A node in the view it was read in; `undefined` when absent. */
  nodeRead(runId: string, name: string): NodeRead | undefined {
    const key = nodeKey(runId, name)
    const read = this.#nodes.get(key)
    if (read || this.#whole(runId) || this.#listed.has(runId)) return read
    if (this.#seen.nodes.has(key)) return undefined
    throw new NeedMore({ open: [{ runId, maps: [] }] })
  }

  /** A node with its input; `undefined` when absent. */
  node(runId: string, name: string): StoredNode | undefined {
    const key = nodeKey(runId, name)
    const read = this.#nodes.get(key)
    if (read?.view === 'full') return read.record
    if (!read && (this.#whole(runId) || this.#listed.has(runId))) {
      return undefined
    }
    if (!read && this.#seen.nodes.has(key)) return undefined
    throw new NeedMore({ runs: [runId] })
  }

  child(runId: string, nodeName: string, key: string): StoredChild | undefined {
    const at = childKey(runId, nodeName, key)
    const child = this.#children.get(at)
    if (
      child ||
      this.#everyChild(runId, nodeName) ||
      this.#seen.children.has(at)
    ) {
      return child
    }
    throw new NeedMore({ units: [{ runId, nodeName, childKey: key }] })
  }

  attempt(runId: string, id: string): StoredAttempt | undefined {
    const attempt = this.#attempts.get(id)
    if (attempt?.runId === runId) return attempt
    // A unit that found no such attempt found none under its child only.
    if (this.#whole(runId) || this.#seen.attempts.has(id)) return undefined
    throw new NeedMore({ runs: [runId] })
  }

  /**
   * A map node's work: every child under way, and those waiting by ordinal,
   * at least the first `pendingLimit` of them when there are that many. A
   * node whose children were read in a smaller window is read again in this
   * one; `hasMore` says whether more wait beyond the children given.
   */
  work(runId: string, nodeName: string, pendingLimit: number | 'all'): MapWork {
    const key = nodeKey(runId, nodeName)
    const read = this.#everyChild(runId, nodeName) ? 'all' : this.#read.get(key)
    if (
      read === undefined ||
      (read !== 'all' &&
        read.hasMore &&
        exceeds(pendingLimit, read.pendingLimit))
    ) {
      throw new NeedMore({
        open: [{ runId, maps: [{ nodeName, pendingLimit }] }],
      })
    }
    const active: StoredChild[] = []
    const pending: StoredChild[] = []
    for (const child of this.#byNode.get(key)?.values() ?? []) {
      if (child.status === STATUSES.pending) pending.push(child)
      else if (!isTerminal(child.status)) active.push(child)
    }
    pending.sort(byOrdinal)
    const window =
      read === 'all' ? { pendingLimit: 'all' as const, hasMore: false } : read
    return { ...window, active, pending }
  }

  /**
   * A node with its input and every child, by ordinal, as the plan's writes
   * left them; `undefined` when the node is absent.
   */
  results(runId: string, nodeName: string): NodeResults | undefined {
    const key = nodeKey(runId, nodeName)
    const read = this.#nodes.get(key)
    if (read?.view === 'full' && this.#everyChild(runId, nodeName)) {
      const children = Array.from(this.#byNode.get(key)?.values() ?? [])
      return { node: read.record, children: children.sort(byOrdinal) }
    }
    if (!read && (this.#whole(runId) || this.#listed.has(runId))) {
      return undefined
    }
    if (!read && this.#seen.nodes.has(key)) return undefined
    throw new NeedMore({ childResults: [{ runId, nodeName }] })
  }

  createRun(fields: Created<StoredRun, 'status' | 'tags' | 'activeSince'>) {
    const { id } = fields
    // A family read guards its root without reading it: made again, the
    // root would be written over unseen, with all it owns.
    if (this.#runs.has(id) || this.#snapshot.families.get(id)) {
      throw new Error(`Created run [${id}], which exists`)
    }
    this.#created.add(id)
    return this.#putRun({
      status: 'queued',
      tags: {},
      activeSince: this.now,
      ...fields,
      version: 1,
      createdAt: this.now,
      updatedAt: this.now,
    })
  }

  /** Writes a run whose record was read or made here. */
  updateRun(run: StoredRun, patch: Partial<StoredRun>) {
    if (!this.#runs.has(run.id)) {
      throw new Error(`Wrote run [${run.id}] without reading it`)
    }
    return this.#putRun(this.#next(run, patch))
  }

  /**
   * Adds a node to a run loaded whole or created, or to one opened that has
   * no node of the name: an open read saw every node of its run.
   */
  createNode(fields: Created<StoredNode, never>) {
    const { runId, name } = fields
    const key = nodeKey(runId, name)
    if (
      !this.#whole(runId) &&
      !(this.#listed.has(runId) && !this.#nodes.has(key))
    ) {
      throw new Error(
        `Created node [${name}] in run [${runId}] not loaded whole`,
      )
    }
    this.#createdNodes.add(key)
    return this.#putNode({
      ...fields,
      version: 1,
      createdAt: this.now,
      updatedAt: this.now,
    })
  }

  /** Writes a node whole: one read with its input. */
  updateNode(node: StoredNode, patch: Partial<StoredNode>) {
    const key = nodeKey(node.runId, node.name)
    const read = this.#nodes.get(key)
    if (read?.view !== 'full') {
      throw new Error(
        `Wrote [${key}] without reading ${read ? 'its input' : 'it'}`,
      )
    }
    return this.#putNode(this.#next(node, patch))
  }

  /**
   * Writes a node but for its input, which stays as stored: how a map's is
   * written, read without its list. A patch that names the input, even as
   * `undefined`, is refused: what is not read is not written.
   */
  updateNodeKeepingInput(
    node: NodeWithoutInput,
    patch: Partial<NodeWithoutInput>,
  ): NodeWithoutInput {
    const key = nodeKey(node.runId, node.name)
    if (Object.hasOwn(patch, 'input')) {
      throw new Error(`Wrote the input of [${key}], which is kept`)
    }
    const read = this.#nodes.get(key)
    if (!read) throw new Error(`Wrote [${key}] without reading it`)
    const next = this.#next(withoutInput(node), patch)
    if (read.view === 'withoutInput') {
      this.#setNode({ view: 'withoutInput', record: next })
    } else {
      // Read whole: its input is known, and is what it keeps.
      const { record } = read
      this.#setNode({
        view: 'full',
        record: Object.hasOwn(record, 'input')
          ? { ...next, input: record.input }
          : next,
      })
    }
    // Written whole already, it is written whole again.
    if (!this.#written.nodes.has(key)) this.#written.preserving.add(key)
    return next
  }

  /**
   * Adds a child where all children of its node are known: of a run loaded
   * whole or created, of a node the plan created, or of a node whose
   * children were read all. Never into a map's window, beyond which a child
   * of the same key may be stored. A node that is absent has no children,
   * and gets one only when the plan creates it too, before or after.
   */
  createChild(fields: Created<StoredChild, 'attemptCount'>) {
    const { runId, nodeName, childKey: key } = fields
    if (!this.#everyChild(runId, nodeName)) {
      throw new Error(
        `Created child [${nodeName}.${key}] in run [${runId}] not loaded whole`,
      )
    }
    return this.#putChild({
      attemptCount: 0,
      ...fields,
      version: 1,
      createdAt: this.now,
      updatedAt: this.now,
    })
  }

  updateChild(child: StoredChild, patch: Partial<StoredChild>) {
    const { runId, nodeName, childKey: key } = child
    this.#loaded(this.#children, childKey(runId, nodeName, key))
    return this.#putChild(this.#next(child, patch))
  }

  /**
   * Adds an attempt to a run loaded whole or created, or, with an id the
   * snapshot gave, under a child that was read or made: a retry needs no
   * more of the run than the unit it retries.
   */
  createAttempt(fields: Omit<StoredAttempt, 'status' | 'dispatchedAt'>) {
    const { id, runId, nodeName, childKey: key } = fields
    if (
      !this.#whole(runId) &&
      !(
        this.#minted.has(id) &&
        this.#children.has(childKey(runId, nodeName, key))
      )
    ) {
      throw new Error(`Attempt [${id}] added to a child the plan did not load`)
    }
    return this.#putAttempt({
      status: 'started',
      dispatchedAt: this.now,
      ...fields,
    })
  }

  updateAttempt(attempt: StoredAttempt, patch: Partial<StoredAttempt>) {
    this.#loaded(this.#attempts, attempt.id)
    return this.#putAttempt({ ...attempt, ...patch })
  }

  /** Adds a schedule: the names of all schedules are loaded by then. */
  createSchedule(
    fields: Omit<StoredSchedule, 'version' | 'createdAt' | 'updatedAt'>,
  ) {
    this.scheduleNames()
    return this.#putSchedule({
      ...fields,
      version: 1,
      createdAt: this.now,
      updatedAt: this.now,
    })
  }

  updateSchedule(schedule: StoredSchedule, patch: Partial<StoredSchedule>) {
    return this.#putSchedule(this.#next(schedule, patch))
  }

  removeSchedule(name: string) {
    this.scheduleNames()
    this.#schedules.set(name, undefined)
  }

  enqueue(command: Command, availableAt?: Timestamp) {
    const dedupe =
      command.kind === 'continueRun'
        ? `continue:${command.runId}`
        : `attempt:${command.attemptId}`
    this.#enqueue.push({
      command,
      dedupe,
      ...(availableAt === undefined ? {} : { availableAt }),
    })
  }

  ack(claim: Claim) {
    this.#ack.push(claim)
  }

  /** Makes the commit one of the delivery that still holds the claim. */
  hold(claim: Claim) {
    this.#hold.push(claim)
  }

  acquire(key: string, runId: string) {
    this.#keys.push({ op: 'acquire', key, runId })
  }

  /** Frees a key the run holds; a key held by another run is left alone. */
  release(key: string, runId: string) {
    if (this.holder(key) === runId)
      this.#keys.push({ op: 'release', key, runId })
  }

  mutation(): Mutation {
    const pick = <Record>(
      records: ReadonlyMap<string, Record>,
      written: ReadonlySet<string>,
    ) => Array.from(written, (key) => records.get(key)!)

    const runs = pick(this.#runs, this.#written.runs)
    const nodes = pick(this.#nodes, this.#written.nodes).map((read) =>
      this.#full(read),
    )
    const nodesPreservingInput = pick(
      this.#nodes,
      this.#written.preserving,
    ).map(({ record }) => withoutInput(record))
    const children = pick(this.#children, this.#written.children)
    const attempts = pick(this.#attempts, this.#written.attempts)
    // A child of no node would be found by nothing that finds what a run
    // owns by its nodes, removal included.
    for (const { runId, nodeName, childKey: key } of children) {
      if (!this.#nodes.has(nodeKey(runId, nodeName))) {
        throw new Error(
          `Wrote [${childKey(runId, nodeName, key)}] of a node that is absent`,
        )
      }
    }

    // Derived from what was written, so no plan can forget a hint.
    const notify = new Set<string>()
    for (const { id, status } of runs) {
      if (isTerminal(status) || status === 'cancelling') {
        notify.add(stopTopic(id))
      }
    }
    for (const run of runs) notify.add(familyTopic(run.rootRunId))
    for (const { runId } of [
      ...nodes,
      ...nodesPreservingInput,
      ...children,
      ...attempts,
    ]) {
      // What a run owns is written by plans that read the run's record.
      notify.add(familyTopic(this.#runs.get(runId)!.rootRunId))
    }
    // Whoever watches a run of it then finds it gone.
    for (const rootRunId of this.#removed) notify.add(familyTopic(rootRunId))

    const schedules = Array.from(this.#schedules)
    return {
      runs,
      nodes,
      nodesPreservingInput,
      children,
      attempts,
      keys: this.#keys,
      definitions: Array.from(this.#definitions.values()),
      schedules: schedules.flatMap(([, schedule]) => schedule ?? []),
      unschedule: schedules.flatMap(([name, schedule]) =>
        schedule ? [] : [name],
      ),
      remove: Array.from(this.#removed),
      enqueue: this.#enqueue,
      ack: this.#ack,
      hold: this.#hold,
      notify: Array.from(notify),
    }
  }

  #next<Record extends { readonly version: number }>(
    record: Record,
    patch: Partial<Record>,
  ): Record {
    return {
      ...record,
      ...patch,
      version: record.version + 1,
      updatedAt: this.now,
    }
  }

  /** Whether all a run owns is here: it was loaded whole, or made here. */
  #whole(runId: string) {
    return this.#snapshot.runs.has(runId) || this.#created.has(runId)
  }

  /**
   * Whether every child of a node is here: its run is, or the plan made the
   * node, or its children were read all, or an open read found no node.
   */
  #everyChild(runId: string, nodeName: string) {
    const key = nodeKey(runId, nodeName)
    return (
      this.#whole(runId) ||
      this.#createdNodes.has(key) ||
      this.#read.get(key) === 'all' ||
      (this.#listed.has(runId) && !this.#nodes.has(key))
    )
  }

  /** A node of a run loaded whole is read whole. */
  #full(read: NodeRead): StoredNode {
    if (read.view === 'full') return read.record
    const { runId, name } = read.record
    throw new Error(`Node [${nodeKey(runId, name)}] was read without its input`)
  }

  #loaded(records: ReadonlyMap<string, unknown>, key: string) {
    if (!records.has(key)) throw new Error(`Wrote [${key}] without reading it`)
  }

  #putSchedule(schedule: StoredSchedule) {
    this.#schedules.set(schedule.name, schedule)
    return schedule
  }

  #putRun(run: StoredRun) {
    this.#runs.set(run.id, run)
    this.#written.runs.add(run.id)
    return run
  }

  #own(runId: string): Owned {
    let own = this.#owned.get(runId)
    if (!own) {
      own = { nodes: new Map(), children: new Map(), attempts: new Map() }
      this.#owned.set(runId, own)
    }
    return own
  }

  #setNode(read: NodeRead) {
    const key = nodeKey(read.record.runId, read.record.name)
    this.#nodes.set(key, read)
    this.#own(read.record.runId).nodes.set(key, read)
    return key
  }

  #setChild(child: StoredChild) {
    const { runId, nodeName } = child
    const key = childKey(runId, nodeName, child.childKey)
    this.#children.set(key, child)
    this.#own(runId).children.set(key, child)
    const node = nodeKey(runId, nodeName)
    let siblings = this.#byNode.get(node)
    if (!siblings) {
      siblings = new Map()
      this.#byNode.set(node, siblings)
    }
    siblings.set(child.childKey, child)
    return key
  }

  #setAttempt(attempt: StoredAttempt) {
    this.#attempts.set(attempt.id, attempt)
    this.#own(attempt.runId).attempts.set(attempt.id, attempt)
    return attempt.id
  }

  #putNode(node: StoredNode) {
    const key = this.#setNode({ view: 'full', record: node })
    this.#written.preserving.delete(key)
    this.#written.nodes.add(key)
    return node
  }

  #putChild(child: StoredChild) {
    this.#written.children.add(this.#setChild(child))
    return child
  }

  #putAttempt(attempt: StoredAttempt) {
    this.#written.attempts.add(this.#setAttempt(attempt))
    return attempt
  }
}

/**
 * Makes a plan from a body that works on a draft. The body returns its result,
 * or `Refused` to fail the operation without writing anything.
 */
export function planning<A, E = never>(
  body: (draft: Draft) => A | Refused<E>,
): Plan<A, E> {
  return (snapshot) => {
    const draft = new Draft(snapshot)
    try {
      const result = body(draft)
      if (result instanceof Refused) {
        return { _tag: 'Fail', error: result.error }
      }
      return { _tag: 'Commit', mutation: draft.mutation(), result }
    } catch (error) {
      if (error instanceof NeedMore) return { _tag: 'Need', scope: error.scope }
      if (error instanceof Unwritten) {
        return { _tag: 'Commit', mutation: {}, result: error.result as A }
      }
      throw error
    }
  }
}
