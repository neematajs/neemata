import * as Effect from 'effect/Effect'
import * as Latch from 'effect/Latch'
import * as Layer from 'effect/Layer'
import * as Redis from 'effect/persistence/Redis'
import * as Queue from 'effect/Queue'
import * as Schedule from 'effect/Schedule'

import type {
  Command,
  RunRecords,
  RunStatus,
  RunSummary,
  StoredAttempt,
  StoredChild,
  StoredNode,
  StoredRun,
  StoredSchedule,
  Timestamp,
} from '../model.ts'
import type {
  ChildResults,
  ChildSet,
  Claim,
  ClaimOptions,
  DeadCommand,
  Family,
  ListedRun,
  Mutation,
  OpenRecords,
  Page,
  Plan,
  ReadScope,
  ReleaseOptions,
  RunFilter,
  Snapshot,
  UnitRead,
  UnitRecords,
} from '../store.ts'
import type { DeadFields, Loaded } from './scripts.ts'
import { StaleClaim, StorageError } from '../errors.ts'
import { isMap, isTerminal, STATUSES, storedError } from '../model.ts'
import {
  foundRuns,
  malformed,
  opened,
  resultsKey,
  Store,
  unitKey,
  unloaded,
  widened,
} from '../store.ts'
import {
  CLAIM,
  CLAIMED,
  COMMIT,
  DEAD,
  PRUNABLE,
  READ,
  RELEASE,
  RENEW,
  RUNS,
  SCHEDULES,
} from './scripts.ts'

export type RedisOptions = {
  /** A command claimed more often than this is set aside as dead. */
  readonly maxDeliveries?: number
  /**
   * What tells this store's keys and channel from all others on the server;
   * `PREFIX` when omitted. Every key begins with it in braces, a hash tag,
   * so a cluster keeps the whole store in one slot. It may not be empty nor
   * hold a brace: either would break the tag.
   */
  readonly prefix?: string
  /**
   * How often a commit that found its snapshot changed is planned again
   * before it fails with `StorageError`; 32 when omitted.
   */
  readonly maxAttempts?: number
  /**
   * Run with every planned mutation before it is committed. For tests: it is
   * the gap a concurrent writer acts in.
   */
  readonly beforeCommit?: (mutation: Mutation) => Effect.Effect<unknown>
}

/**
 * The prefix by default. It is the Promise engine's too, and safe to share
 * with it: none of that engine's keys begins with a brace.
 */
export const PREFIX = 'nmtjs:workflows:'

const KIND = 'kind:'
const TOPIC = 'topic:'

// A commit that lost a race waits a moment that grows with every loss, and
// differs from that of whoever it raced.
const BACKOFF_MS = 50

/** A cursor of a list of runs: when one was created, and its turn. */
const PLACE = /^\d{31}$/
/** A cursor of the roots that may be pruned: the whole of an index entry. */
const AGED = /^\d{31}:/
const instant = (at: Timestamp) => String(Math.ceil(at)).padStart(15, '0')

const json = (value: unknown) => JSON.stringify(value)
const unique = <A>(items: readonly A[] = []) => Array.from(new Set(items))

/**
 * What is stored behind the revision it was written at: the two are one
 * value, so a key, definition or schedule that is gone leaves no revision
 * behind.
 */
const revised = (stored: string) => stored.slice(stored.indexOf(' ') + 1)

type Guard = readonly [kind: string, name: string]

/** A guard as the reference store names it, for what a plan is told. */
const guardName = ([kind, name]: Guard) =>
  kind === 'scheduleNames' ? 'schedules' : `${kind}:${name}`

/**
 * What a scope guards. A family is guarded by its root and its counts, and
 * not by the runs under it, which have guards of their own.
 */
const guards = (scope: ReadScope): Guard[] => [
  // A unit is guarded by its run, as the run's one revision.
  ...[
    ...(scope.runs ?? []),
    ...(scope.heads ?? []),
    ...(scope.units ?? []).map(({ runId }) => runId),
    ...(scope.open ?? []).map(({ runId }) => runId),
    ...(scope.childResults ?? []).map(({ runId }) => runId),
  ].map((id): Guard => ['run', id]),
  ...(scope.keys ?? []).map((key): Guard => ['key', key]),
  ...(scope.definitions ?? []).map((key): Guard => ['definition', key]),
  ...(scope.schedules ?? []).map((name): Guard => ['schedule', name]),
  ...(scope.scheduleNames ? [['scheduleNames', ''] as const] : []),
  ...(scope.families ?? []).map((id): Guard => ['family', id]),
  ...(scope.dead ?? []).map((id): Guard => ['dead', id]),
]

function deadCommand(id: string, fields: DeadFields): DeadCommand {
  const [command, deliveries, error, createdAt, deadAt] = fields
  return {
    id,
    command: JSON.parse(command),
    deliveries: Number(deliveries),
    ...(error === null ? {} : { error: JSON.parse(error) }),
    createdAt: Number(createdAt),
    deadAt: Number(deadAt),
  }
}

/**
 * The lane a command is queued in and claimed from: its kind and its route.
 * A route without a revision is a lane of its own, never a wildcard.
 */
const lane = (kind: string, name: string, revision?: string) =>
  json([kind, name, revision ?? null])

/**
 * The indexes that list a run, by what a filter may name. Every one holds
 * runs in the one order of all lists of runs.
 */
const term = {
  all: 'all',
  kind: (kind: string) => `kind:${kind}`,
  name: (name: string) => `name:${name}`,
  revision: (revision?: string | null) =>
    revision == null ? 'unversioned' : `revision:${revision}`,
  status: (status: RunStatus) => `status:${status}`,
  parent: (runId?: string | null) =>
    runId == null ? 'roots' : `parent:${runId}`,
  root: (runId: string) => `root:${runId}`,
  /** The runs under a root that have not ended: what a family counts. */
  active: (rootRunId: string) => `active:${rootRunId}`,
  tag: (key: string, value: string) => `tag:${json([key, value])}`,
}

const terms = (run: StoredRun) => [
  term.all,
  term.kind(run.kind),
  term.name(run.name),
  term.revision(run.revision),
  term.status(run.status),
  term.parent(run.parentRunId),
  term.root(run.rootRunId),
  ...(isTerminal(run.status) ? [] : [term.active(run.rootRunId)]),
  ...Object.entries(run.tags).map(([key, value]) => term.tag(key, value)),
]

/**
 * The fields of a run's hash that hold what it owns, by their first letter:
 * a node is kept without its input, which is a field of its own.
 */
const FIELD = { node: 'N', input: 'I', child: 'C', attempt: 'A' } as const
const pair = ({
  nodeName,
  childKey,
}: Pick<StoredChild, 'nodeName' | 'childKey'>) => json([nodeName, childKey])

/**
 * A run is kept in two parts, so that a list reads no payload it does not
 * show.
 */
function parts(run: StoredRun) {
  const { input, output, presentation, ...summary } = run
  return { run: json(summary), io: json({ input, output, presentation }) }
}

const head = (run: string | null, io: string | null): StoredRun | undefined =>
  run === null ? undefined : { ...JSON.parse(run), ...JSON.parse(io ?? '{}') }

/** A node as kept: without its input, and its input when it has one. */
function nodeParts(node: StoredNode) {
  const { input, ...rest } = node
  return {
    node: json(rest),
    input: input === undefined ? false : json(input),
  }
}

/** A node read with its input, from its two fields. */
const whole = (node: string, input: string | null): StoredNode => ({
  ...JSON.parse(node),
  ...(input === null ? {} : { input: JSON.parse(input) }),
})

/** A unit as its fields were read; an attempt of another child is absent. */
function unitRecords(
  { runId, nodeName, childKey }: UnitRead,
  [run, io, node, input, child, attempt]: Loaded[4][number],
): UnitRecords {
  const found: StoredAttempt | undefined =
    attempt === null ? undefined : JSON.parse(attempt)
  return {
    run: head(run, io),
    node: node === null ? undefined : whole(node, input),
    child: child === null ? undefined : JSON.parse(child),
    attempt:
      found?.runId === runId &&
      found.nodeName === nodeName &&
      found.childKey === childKey
        ? found
        : undefined,
  }
}

/** A run opened, from the fields read; a map's node lacks its input. */
function openRecords(
  maps: ReadonlyMap<string, number | 'all'>,
  read: Loaded[5][number],
): OpenRecords | undefined {
  if (read === null) return undefined
  const [run, io, nodes, sets, attempts, linked] = read
  return {
    run: head(run, io)!,
    nodes: nodes.map(([node, input]) => {
      const record: StoredNode = whole(node, input)
      return isMap(record.kind)
        ? { view: 'withoutInput', record }
        : { view: 'full', record }
    }),
    childSets: new Map(
      sets.map(([name, mapped, fields]): [string, ChildSet] => {
        const children: StoredChild[] = fields.map((child) => JSON.parse(child))
        if (!mapped) return [name, { view: 'all', children }]
        return [
          name,
          {
            view: 'map',
            active: children.filter(
              ({ status }) => status !== STATUSES.pending,
            ),
            pending: children.filter(
              ({ status }) => status === STATUSES.pending,
            ),
            pendingLimit: maps.get(name)!,
            hasMore: mapped === 2,
          },
        ]
      }),
    ),
    attempts: attempts.map((attempt) => JSON.parse(attempt)),
    linked: new Map(linked.map(([id, run, io]) => [id, head(run, io)])),
  }
}

function records(fields: readonly string[]): RunRecords | undefined {
  let run: string | null = null
  let io: string | null = null
  const nodes = new Map<string, string>()
  const inputs = new Map<string, string>()
  const children: StoredChild[] = []
  const attempts: StoredAttempt[] = []
  for (let index = 0; index < fields.length; index += 2) {
    const field = fields[index]!
    const value = fields[index + 1]!
    if (field === 'run') run = value
    else if (field === 'io') io = value
    else if (field[0] === FIELD.node) nodes.set(field.slice(1), value)
    else if (field[0] === FIELD.input) inputs.set(field.slice(1), value)
    else if (field[0] === FIELD.child) children.push(JSON.parse(value))
    else if (field[0] === FIELD.attempt) attempts.push(JSON.parse(value))
  }
  const stored = head(run, io)
  // By their keys, as every adapter gives them: a hash gives its fields in
  // an order of its own, which changes as it grows.
  const by =
    <A>(key: (record: A) => string) =>
    (a: A, b: A) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0
  return (
    stored && {
      run: stored,
      nodes: Array.from(nodes, ([name, node]) =>
        whole(node, inputs.get(name) ?? null),
      ).sort(by(({ name }) => name)),
      children: children.sort(by(pair)),
      attempts: attempts.sort(by(({ id }) => id)),
    }
  )
}

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

/**
 * Whether a filter selects a run. An index only narrows what is read: every
 * run it gives is judged here, by the whole filter.
 */
function matches(
  run: RunSummary & { readonly input?: unknown },
  filter: RunFilter,
) {
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

/**
 * The sets of indexes that each hold every run a filter selects: one for
 * each thing it names. The script reads the smallest.
 */
function drivers(filter: RunFilter) {
  const { revision, parentRunId } = filter
  const found: string[][] = []
  if (filter.kind !== undefined) found.push([term.kind(filter.kind)])
  if (filter.name !== undefined) found.push([term.name(filter.name)])
  if (revision !== undefined) found.push([term.revision(revision)])
  if (filter.status !== undefined) {
    found.push(unique(filter.status).map(term.status))
  }
  if (parentRunId !== undefined) found.push([term.parent(parentRunId)])
  if (filter.rootRunId !== undefined) found.push([term.root(filter.rootRunId)])
  for (const [key, value] of Object.entries(filter.tags ?? {})) {
    found.push([term.tag(key, value)])
  }
  return found.length > 0 ? found : [[term.all]]
}

/**
 * A page of what was read one past the limit: the extra item says there is
 * more, and the place of the last one kept is where the next page begins.
 */
function page<A>(
  read: readonly A[],
  limit: number,
  place: (item: A) => string,
) {
  const items = read.slice(0, limit)
  return read.length > items.length && items.length > 0
    ? { items, next: place(items.at(-1)!) }
    : { items }
}

/**
 * The store on Redis. It needs the `Redis` service and nothing else, so any
 * driver that provides one serves. Nothing is held while a plan runs: a
 * commit checks that what the plan read is as it was, and is planned again
 * when it is not.
 */
export const make = Effect.fnUntraced(function* (options: RedisOptions = {}) {
  const redis = yield* Redis.Redis
  const { maxDeliveries = 20, maxAttempts = 32, prefix = PREFIX } = options
  if (prefix === '' || /[{}]/.test(prefix)) {
    return yield* Effect.die(
      new Error(`Workflow key prefix [${prefix}] is empty or holds a brace`),
    )
  }
  for (const [name, value] of Object.entries({ maxDeliveries, maxAttempts })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      return yield* Effect.die(
        new Error(`${name} [${value}] must be a positive integer`),
      )
    }
  }
  const root = `{${prefix}}`

  const storage = <A>(effect: Effect.Effect<A, Redis.RedisError>) =>
    Effect.mapError(effect, (cause) => new StorageError({ cause }))
  const run =
    <Result>(script: Redis.Script<{ params: any; result: Result }>) =>
    (...args: readonly (string | number)[]) =>
      storage(redis.eval(script)(root, ...args))

  // One latch per subscription, open while a hint waits to be taken, with
  // the messages that are hints to it.
  const listeners = new Map<Latch.Latch, readonly string[]>()
  const hint = (message?: string) => {
    for (const [latch, wanted] of listeners) {
      if (message === undefined || wanted.includes(message)) latch.openUnsafe()
    }
  }

  // One subscription serves every listener of the store: a driver may open a
  // connection for each.
  const settled = Latch.makeUnsafe()
  const hear = Effect.scoped(
    Effect.gen(function* () {
      const messages = yield* redis.subscribe(`${root}hints`)
      // What was published while nothing listened is not known.
      hint()
      settled.openUnsafe()
      for (;;) hint((yield* Queue.take(messages)).message)
    }),
  )
  yield* Effect.forkScoped(
    hear.pipe(
      Effect.tapError((error) =>
        Effect.andThen(
          settled.open,
          Effect.logWarning(
            'Workflow hints are not listened for; workers poll',
            error,
          ),
        ),
      ),
      Effect.retry(Schedule.spaced('1 second')),
    ),
  )
  // Either way: a store that cannot listen yet is a store that polls.
  yield* settled.await

  const read = (scope: ReadScope) => {
    const guarded = guards(scope)
    const units = Array.from(
      new Map((scope.units ?? []).map((unit) => [unitKey(unit), unit])),
    )
    const open = Array.from(opened(scope))
    const results = Array.from(
      new Map(
        (scope.childResults ?? []).map((read) => [resultsKey(read), read]),
      ),
    )
    const asked = {
      guards: guarded,
      runs: unique(scope.runs),
      heads: unique(scope.heads),
      units: units.map(([, { runId, nodeName, childKey, attemptId }]) => [
        runId,
        nodeName,
        pair({ nodeName, childKey }),
        attemptId ?? false,
      ]),
      // A window reaches one past its limit, which tells whether more wait.
      open: open.map(([runId, maps]) => [
        runId,
        Array.from(maps, ([name, limit]) => [
          name,
          limit === 'all' ? -1 : limit,
        ]),
      ]),
      results: results.map(([, { runId, nodeName }]) => [runId, nodeName]),
      keys: unique(scope.keys),
      definitions: unique(scope.definitions),
      schedules: unique(scope.schedules),
      scheduleNames: scope.scheduleNames === true,
      families: unique(scope.families),
      dead: unique(scope.dead),
      ended: STATUSES.terminal,
    }
    return Effect.map(run(READ)(json(asked)), (loaded) => {
      const [now, revisions, runs, heads, fields, ...rest] = loaded
      const [openFields, resultFields, keys, definitions, ...more] = rest
      const [schedules, scheduleNames, families, dead] = more
      const entries = <Raw, A>(
        names: readonly string[],
        raw: readonly Raw[],
        decode: (raw: Raw) => A,
      ) => new Map(names.map((name, index) => [name, decode(raw[index]!)]))

      const minted = new Set<string>()
      const snapshot: Snapshot = {
        now,
        id: () => {
          const id = crypto.randomUUID()
          minted.add(id)
          return id
        },
        runs: entries(asked.runs, runs, records),
        heads: entries(asked.heads, heads, ([run, io]) => head(run, io)),
        units: new Map(
          units.map(([key, unit], index) => [
            key,
            unitRecords(unit, fields[index]!),
          ]),
        ),
        open: new Map(
          open.map(([runId, maps], index) => [
            runId,
            openRecords(maps, openFields[index]!),
          ]),
        ),
        childResults: new Map(
          results.map(([key], index): [string, ChildResults] => {
            const [node, input, children] = resultFields[index]!
            return [
              key,
              {
                node: node === null ? undefined : whole(node, input),
                children: children.map((child) => JSON.parse(child)),
              },
            ]
          }),
        ),
        keys: entries(asked.keys, keys, (held) =>
          held === null ? undefined : revised(held),
        ),
        definitions: entries(asked.definitions, definitions, (saved): unknown =>
          saved === null ? undefined : JSON.parse(revised(saved)),
        ),
        schedules: entries(
          asked.schedules,
          schedules,
          (stored): StoredSchedule | undefined =>
            stored === null ? undefined : JSON.parse(revised(stored)),
        ),
        scheduleNames: scheduleNames ?? undefined,
        families: entries(
          asked.families,
          families,
          ([stored, size, active, activeRunId, claimedRunId]) => {
            if (stored === null) return undefined
            const found: Family = {
              root: JSON.parse(stored),
              size,
              active,
              ...(activeRunId === null ? {} : { activeRunId }),
              ...(claimedRunId === null ? {} : { claimedRunId }),
            }
            return found
          },
        ),
        dead: new Map(
          asked.dead.map((id, index) => {
            const fields = dead[index]
            return [id, fields == null ? undefined : deadCommand(id, fields)]
          }),
        ),
      }
      return {
        snapshot,
        guards: [
          ...guarded.map(
            ([kind, name], index) => [kind, name, revisions[index]!] as const,
          ),
          // The runs of the children an open read read, at the revision the
          // same script read them at.
          ...openFields.flatMap((read) =>
            (read?.[5] ?? []).map(
              ([id, , , revision]) => ['run', id, revision] as const,
            ),
          ),
        ],
        minted,
      }
    })
  }

  /**
   * A mutation as the commit script takes it, or nothing when there is
   * nothing to check or write. Throws for a write to what the plan did not
   * load: that is a mistake of the plan's, which no stored state excuses.
   */
  function prepared(
    mutation: Mutation,
    scope: ReadScope,
    snapshot: Snapshot,
    seen: readonly (readonly [kind: string, name: string, revision: string])[],
    minted: ReadonlySet<string>,
  ) {
    const guarded = new Set([
      ...seen.map(([kind, name]) => guardName([kind, name])),
      // A family is guarded by its root.
      ...(scope.families ?? []).map((id) => `run:${id}`),
    ])
    const check = (name: string) => {
      if (!guarded.has(name)) throw new Error(`Unguarded write to [${name}]`)
    }

    const runs = mutation.runs ?? []
    const written = new Set(runs.map(({ id }) => id))
    const found = foundRuns(snapshot)
    const nodes = mutation.nodes ?? []
    const kept = mutation.nodesPreservingInput ?? []
    const children = mutation.children ?? []
    const attempts = mutation.attempts ?? []
    // What a run owns is written to a run the plan loaded, which the script
    // finds there, or to one the mutation creates.
    const owners = new Set<string>()
    for (const { runId } of [...nodes, ...kept, ...children, ...attempts]) {
      if (written.has(runId)) continue
      check(`run:${runId}`)
      owners.add(runId)
    }
    // Of what a run owns, only what the plan read: a guard is not a view.
    const unread = unloaded(snapshot, mutation, (id) => minted.has(id))
    if (unread !== undefined) throw new Error(`Unguarded write to [${unread}]`)
    // As the script refuses it too: a score that is no number would fail
    // its writes halfway.
    const wrong = malformed(mutation)
    if (wrong !== undefined) throw new Error(wrong)
    for (const { name } of mutation.schedules ?? []) {
      check(`schedule:${name}`)
      if (snapshot.schedules.get(name) === undefined) check('schedules')
    }
    for (const name of mutation.unschedule ?? []) {
      check(`schedule:${name}`)
      check('schedules')
    }
    for (const id of mutation.remove ?? []) {
      if (!scope.families?.includes(id)) {
        throw new Error(`Unguarded removal of family [${id}]`)
      }
    }
    for (const { key } of mutation.keys ?? []) check(`key:${key}`)
    for (const { key } of mutation.definitions ?? []) check(`definition:${key}`)

    const claims = (claimed: readonly Claim[] = []) =>
      claimed.map(({ id, token }) => [id, token])
    const body = {
      now: snapshot.now,
      guards: seen,
      acks: claims(mutation.ack),
      holds: claims(mutation.hold),
      // A run written that the plan did not read is one it creates: it is
      // refused if the run is there, guarded or not.
      fresh: Array.from(written).filter((id) => !found.has(id)),
      owners: Array.from(owners),
      remove: mutation.remove ?? [],
      runs: runs.map((stored) => ({
        id: stored.id,
        ...parts(stored),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        terms: terms(stored),
        ended: isTerminal(stored.status),
        // Roots are also listed by status, for `prunable`.
        ...(stored.parentRunId === undefined ? { aged: stored.status } : {}),
      })),
      // Whole, with its input apart; or but for its input, which is kept.
      nodes: [
        ...nodes.map((node) => ({ ...node, ...nodeParts(node) })),
        ...kept.map((node) => ({ ...node, node: json(node), input: false })),
      ].map(({ runId, name, status, kind, node, input }, index) => [
        runId,
        name,
        node,
        status === STATUSES.completed,
        input,
        // Read by a script, which decodes no record: whether it is a map's
        // and whether it has ended.
        `${isMap(kind) ? 'm' : 'n'}${isTerminal(status) ? 1 : 0}`,
        index >= nodes.length,
      ]),
      children: children.map((child) => [
        child.runId,
        pair(child),
        json(child),
        child.childRunId ?? false,
        json([child.runId, child.nodeName, child.childKey]),
        child.nodeName,
        child.ordinal ?? false,
        child.status === STATUSES.pending
          ? 'pending'
          : (STATUSES.active as readonly string[]).includes(child.status)
            ? 'active'
            : 'ended',
        child.currentAttemptId ?? false,
      ]),
      attempts: attempts.map((attempt) => [
        attempt.runId,
        attempt.id,
        json(attempt),
      ]),
      keys: (mutation.keys ?? []).map(({ op, key, runId }) => [op, key, runId]),
      definitions: (mutation.definitions ?? []).map(({ key, value }) => [
        key,
        json(value),
      ]),
      schedules: (mutation.schedules ?? []).map((schedule) => ({
        name: schedule.name,
        value: json(schedule),
        ...(schedule.enabled ? { due: schedule.nextRunAt } : {}),
      })),
      unschedule: mutation.unschedule ?? [],
      enqueue: (mutation.enqueue ?? []).map(
        ({ command, dedupe, availableAt }) => ({
          command: json(command),
          dedupe,
          availableAt,
          kind: command.kind,
          lane: lane(command.kind, command.name, command.revision),
          runId: command.runId,
        }),
      ),
      notify: unique(mutation.notify),
    }
    const empty = Object.values(body).every(
      (part) => !Array.isArray(part) || part.length === 0,
    )
    // The revision of all it writes: made here, so that no state the server
    // is set back to can give it again.
    return empty ? undefined : json({ ...body, rev: crypto.randomUUID() })
  }

  const transact = <A, E = never>(
    initial: ReadScope,
    plan: Plan<A, E>,
  ): Effect.Effect<A, E | StaleClaim | StorageError> =>
    Effect.gen(function* () {
      let scope = initial
      for (let lost = 0; lost < maxAttempts; ) {
        const { snapshot, guards: seen, minted } = yield* read(scope)
        const planned = plan(snapshot)
        if (planned._tag === 'Fail') return yield* Effect.fail(planned.error)
        if (planned._tag === 'Need') {
          scope = widened(scope, planned.scope)
          continue
        }

        const { mutation } = planned
        if (options.beforeCommit) yield* options.beforeCommit(mutation)
        const body = prepared(mutation, scope, snapshot, seen, minted)
        if (body === undefined) return planned.result
        const [outcome, name] = yield* run(COMMIT)(body)
        if (outcome === 'done') return planned.result
        if (outcome === 'stale') {
          return yield* Effect.fail(new StaleClaim({ commandId: name }))
        }
        if (outcome === 'unguarded') {
          throw new Error(`Unguarded write to [run:${name}]`)
        }
        if (outcome === 'missing') {
          throw new Error(`Run [${name}] does not exist`)
        }
        if (outcome === 'unstored') {
          throw new Error(`Node [${name}] does not exist`)
        }
        if (outcome === 'saved') {
          throw new Error(`Definition [${name}] is already saved`)
        }
        if (outcome === 'malformed') {
          throw new Error(`Wrote [${name}] with a number that is none`)
        }
        // Something read has changed: the plan is void, so plan again.
        lost += 1
        yield* Effect.sleep(Math.random() * Math.min(BACKOFF_MS, 2 ** lost))
      }
      return yield* Effect.fail(
        new StorageError({
          cause: new Error(
            `A commit found its snapshot changed ${maxAttempts} times over`,
          ),
        }),
      )
    })

  const claim = <K extends Command['kind']>(request: ClaimOptions<K>) => {
    const lanes = unique(
      request.lanes.flatMap(({ kind, routes }) =>
        routes.map(({ name, revision }) => lane(kind, name, revision)),
      ),
    )
    if (lanes.length === 0 || request.limit <= 0) return Effect.succeed([])
    return Effect.map(
      // The seed of the tokens is made each time the claim runs: an effect
      // is a value, and one run twice would give two deliveries one token.
      Effect.suspend(() =>
        run(CLAIM)(
          json(lanes),
          request.limit,
          request.leaseMs,
          maxDeliveries,
          crypto.randomUUID(),
        ),
      ),
      (claimed) =>
        claimed.map(
          ([
            id,
            token,
            command,
            deliveries,
            createdAt,
            availableAt,
            claimedAt,
          ]): Claim<Extract<Command, { kind: K }>> => ({
            id,
            token,
            command: JSON.parse(command),
            deliveries,
            createdAt,
            availableAt,
            claimedAt,
          }),
        ),
    )
  }

  const stale = ({ id }: Claim) =>
    Effect.fail(new StaleClaim({ commandId: id }))

  const release = (
    released: Claim,
    { error, delayMs = 0 }: ReleaseOptions = {},
  ) =>
    Effect.flatMap(
      run(RELEASE)(
        released.id,
        released.token,
        delayMs,
        error === undefined ? '' : json(storedError(error)),
      ),
      (held) => (held === 1 ? Effect.void : stale(released)),
    )

  const renew = (renewed: Claim, leaseMs: number) =>
    Effect.flatMap(run(RENEW)(renewed.id, renewed.token, leaseMs), (held) =>
      held === null ? stale(renewed) : Effect.succeed(head(held[0], held[1])),
    )

  /** Subscribes to messages; the effect it gives takes the next hint. */
  const subscribed = (messages: readonly string[]) =>
    Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          const latch = Latch.makeUnsafe()
          listeners.set(latch, messages)
          return latch
        }),
        (latch) => Effect.sync(() => listeners.delete(latch)),
      ),
      (latch) =>
        Effect.andThen(
          latch.await,
          Effect.sync(() => {
            latch.closeUnsafe()
          }),
        ),
    )

  const hints = (kinds: readonly Command['kind'][]) =>
    subscribed(kinds.map((kind) => `${KIND}${kind}`))

  const listen = (topic: string) => subscribed([`${TOPIC}${topic}`])

  const load = (runId: string) =>
    Effect.map(read({ runs: [runId] }), ({ snapshot }) =>
      snapshot.runs.get(runId),
    )

  const listed = (query: {
    readonly filter?: RunFilter
    readonly limit: number
    readonly after?: string
  }) =>
    Effect.gen(function* () {
      const { filter = {}, after } = query
      const limit = Math.max(0, query.limit)
      const nothing: Page<ListedRun> = { items: [] }
      // Not a cursor of this list: it names no place, and nothing follows.
      if (after !== undefined && !PLACE.test(after)) return nothing
      if (limit === 0 || filter.status?.length === 0) return nothing

      // Runs are newest first, so the next are what sorts below a place:
      // the cursor's, or that of the time the filter stops at.
      const { createdBefore: before } = filter
      const bounds = [
        ...(after === undefined ? [] : [after]),
        ...(before !== undefined && before > 0 && before < 1e15
          ? [instant(before)]
          : []),
      ].toSorted()
      let below = bounds[0]
      const size = Math.min(Math.max(limit + 1, 64), 1024)
      const found: (readonly [place: string, run: ListedRun])[] = []
      for (;;) {
        const batch = yield* run(RUNS)(
          json({
            drivers: drivers(filter),
            below: below === undefined ? '+' : `(${below}`,
            count: size,
            io: filter.input !== undefined,
          }),
        )
        for (const [place, [stored, nodes, done, origin, io]] of batch) {
          if (stored === null) continue
          const summary: RunSummary = JSON.parse(stored)
          const payloads = io == null ? {} : JSON.parse(io)
          if (!matches({ ...summary, input: payloads.input }, filter)) continue
          const [, nodeName, childKey] =
            origin === null ? [] : (JSON.parse(origin) as string[])
          found.push([
            place.slice(0, 31),
            {
              ...summary,
              nodesTotal: Number(nodes ?? 0),
              nodesCompleted: Number(done ?? 0),
              ...(nodeName === undefined || childKey === undefined
                ? {}
                : { origin: { nodeName, childKey } }),
            },
          ])
        }
        if (found.length > limit || batch.length < size) break
        below = batch.at(-1)![0]
      }
      const { items, next } = page(found, limit, ([place]) => place)
      return {
        items: items.map(([, listed]) => listed),
        ...(next === undefined ? {} : { next }),
      } satisfies Page<ListedRun>
    })

  const dead = (query: {
    readonly id?: string
    readonly runId?: string
    readonly active?: true
    readonly limit: number
    readonly after?: string
  }) => {
    const { id, runId, active, after } = query
    const limit = Math.max(0, query.limit)
    if (limit === 0 || (after !== undefined && !/^\d+$/.test(after))) {
      return Effect.succeed<Page<DeadCommand>>({ items: [] })
    }
    const indexes = [
      ...(runId === undefined ? [] : [`dead:run:${runId}`]),
      ...(active ? ['dead:active'] : []),
    ]
    return Effect.map(
      run(DEAD)(
        json({
          indexes: indexes.length > 0 ? indexes : ['dead'],
          after: Number(after ?? 0),
          count: limit + 1,
          id,
        }),
      ),
      (read) => {
        const { items, next } = page(read, limit, ([, fields]) => fields[5])
        return {
          items: items.map(([id, fields]) => deadCommand(id, fields)),
          ...(next === undefined ? {} : { next }),
        } satisfies Page<DeadCommand>
      },
    )
  }

  const claimed = (runIds: readonly string[]) => {
    const asked = unique(runIds)
    if (asked.length === 0) return Effect.succeed<readonly string[]>([])
    return Effect.map(run(CLAIMED)(json(asked)), (held) => {
      const under = new Set(asked.filter((_, index) => held[index]! > 0))
      return runIds.filter((id) => under.has(id))
    })
  }

  const schedules = (query: {
    readonly due?: Timestamp
    readonly limit: number
    readonly after?: string
  }) => {
    const limit = Math.max(0, query.limit)
    if (limit === 0) return Effect.succeed<Page<StoredSchedule>>({ items: [] })
    const { due, after } = query
    return Effect.map(
      run(SCHEDULES)(json({ due, after, count: limit + 1 })),
      (read) =>
        page(
          read.map((stored): StoredSchedule => JSON.parse(revised(stored))),
          limit,
          ({ name }) => name,
        ),
    )
  }

  const prunable = (query: {
    readonly status: RunStatus
    readonly updatedBefore: Timestamp
    readonly limit: number
    readonly after?: string
  }) => {
    const { status, updatedBefore: before, after } = query
    const limit = Math.max(0, query.limit)
    const none = before <= 0 || (after !== undefined && !AGED.test(after))
    if (limit === 0 || none) return Effect.succeed<Page<string>>({ items: [] })
    return Effect.map(
      run(PRUNABLE)(
        status,
        after === undefined ? '-' : `(${after}`,
        // Every root changed earlier sorts below this time.
        before < 1e15 ? `(${instant(before)}` : '+',
        limit + 1,
      ),
      (read) => {
        const { items, next } = page(read, limit, (aged) => aged)
        return {
          items: items.map((aged) => aged.slice(32)),
          ...(next === undefined ? {} : { next }),
        } satisfies Page<string>
      },
    )
  }

  return Store.of({
    transact,
    claim,
    release,
    renew,
    hints,
    listen,
    load,
    runs: listed,
    dead,
    claimed,
    schedules,
    prunable,
  })
})

export const layer = (
  options?: RedisOptions,
): Layer.Layer<Store, never, Redis.Redis> => Layer.effect(Store, make(options))
