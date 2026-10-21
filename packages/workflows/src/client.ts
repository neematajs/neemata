import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Stream from 'effect/Stream'

import type { Boundary } from './dsl/codec.ts'
import type {
  DecodedRun,
  InputOf,
  OutputOf,
  UniqueBuilder,
} from './dsl/declaration.ts'
import type { AnyDurableWorkflow } from './dsl/durable.ts'
import type { AnyTask } from './dsl/task.ts'
import type { ServedWorkflow } from './dsl/workflow.ts'
import type { InputRefused, StorageError, UnknownSchedule } from './errors.ts'
import type { RevisionManifest, RunnableRevision } from './graph/revision.ts'
import type {
  DefinitionStructure,
  GraphPresentation,
} from './graph/structure.ts'
import type {
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
import type { Draft } from './plan/draft.ts'
import type { ResumeError, ResumeOptions } from './plan/resume.ts'
import type { RetryError } from './plan/retry.ts'
import type { HeldKey, Receipt } from './plan/send.ts'
import type { StartError, StartInput } from './plan/start.ts'
import type { DeadCommand, ListedRun, RunFilter } from './store.ts'
import type { PruneParams } from './worker/maintenance.ts'
import { decodeRun } from './dsl/declaration.ts'
import * as Engine from './engine.ts'
import {
  DefinitionConflict,
  RunBusy,
  RunNotFound,
  RunNotRoot,
  RunNotTerminal,
  StaleClaim,
  UnknownDefinition,
} from './errors.ts'
import { hashStructure } from './graph/revision.ts'
import { parseStructure } from './graph/structure.ts'
import { isTerminal, ordered } from './model.ts'
import { graphKey, label, revisionKey } from './plan/definitions.ts'
import { familyTopic, planning } from './plan/draft.ts'
import { unretryable } from './plan/retry.ts'
import { revisionOf } from './plan/send.ts'
import { Store } from './store.ts'
import * as Maintenance from './worker/maintenance.ts'

type Declaration = AnyTask | ServedWorkflow

export type StartOptions = {
  /** Each of these replaces what the declaration builds from the input. */
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly unique?: StartInput['unique']
  /** The run exists at once; what starts it is not delivered before this. */
  readonly startAt?: Timestamp
}

/**
 * None of these operations acknowledges a claim, so the store never answers
 * them with a stale one. A storage failure is the caller's to see: every
 * operation here may fail with `StorageError`, and none tries again.
 */
const claimless = <A, E, R>(effect: Effect.Effect<A, E | StaleClaim, R>) =>
  Effect.catchIf(
    effect,
    (error): error is StaleClaim => error instanceof StaleClaim,
    (error) => Effect.die(error),
  ) as Effect.Effect<A, Exclude<E, StaleClaim>, R>

function unique<Input>(
  builder: UniqueBuilder<Input> | undefined,
  input: Input,
): StartInput['unique'] {
  if (builder === undefined) return undefined
  if (typeof builder === 'function') return { key: builder(input) }
  const { key, scope, behavior } = builder
  return {
    key: key(input),
    ...(scope === undefined ? {} : { scope }),
    ...(behavior === undefined ? {} : { behavior }),
  }
}

/**
 * Starts a run of a declared task or workflow, or answers with the run its
 * keys name. It is one commit: the run, what starts it and the definitions it
 * was created with are written together, in the transaction the store is in.
 *
 * An input that does not encode, and a builder that throws, are defects:
 * nothing is written.
 */
export const start = <D extends Declaration>(
  declaration: D,
  input: InputOf<D>,
  options: StartOptions = {},
): Effect.Effect<
  DecodedRun<InputOf<D>, OutputOf<D>>,
  StartError | StorageError,
  Store
> =>
  Effect.suspend(() => {
    const { kind, name, revision } = declaration
    const tags = options.tags ?? declaration.tags?.(input)
    const idempotencyKey =
      options.idempotencyKey ?? declaration.idempotency?.(input)
    const constraint = options.unique ?? unique(declaration.unique, input)
    const { startAt } = options

    return Engine.start({
      kind,
      name,
      ...(revision === undefined ? {} : { revision }),
      definition: declaration.program.definition,
      input: declaration.input.encode(input),
      ...(tags === undefined ? {} : { tags }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(constraint === undefined ? {} : { unique: constraint }),
      ...(startAt === undefined ? {} : { startAt }),
    })
  }).pipe(
    Effect.map(({ run }) => answer(declaration, run)),
    claimless,
  )

/** The run that answered a start, as the caller's declaration types it. */
function answer<D extends Declaration>(
  declaration: D,
  run: StoredRun,
): DecodedRun<InputOf<D>, OutputOf<D>> {
  if (run.name === declaration.name && run.kind === declaration.kind) {
    return decodeRun(declaration, run)
  }
  // Two unversioned runs join whatever they are, so the run that answers may
  // be of another task or workflow: it is read with the codecs the caller
  // has, which are the only ones here.
  const { input, output, ...rest } = run
  return {
    ...rest,
    input: declaration.input.decode(input),
    ...(run.status === 'completed'
      ? { output: declaration.output.decode(output) }
      : {}),
  }
}

/** Asks a run to stop; `undefined` when no such run exists. */
export const cancel = (runId: string) => claimless(Engine.cancel(runId))

/**
 * The run an input is sent to: its id, or the unique key it holds, `active`
 * unless a scope is given. A run that ended no longer holds an `active` key,
 * so a sender that may come after the end keeps the run's id.
 */
export type SendTo =
  | string
  | { readonly unique: HeldKey['key']; readonly scope?: HeldKey['scope'] }

/** One durable workflow, or revisions of one, a sender holds the schemas of. */
type Revisions = AnyDurableWorkflow | readonly AnyDurableWorkflow[]

type Listed<Ds> = Extract<
  Ds extends readonly (infer D)[] ? D : Ds,
  AnyDurableWorkflow
>

/**
 * The input families every revision listed takes: `keyof` a union of input
 * maps is the keys they share.
 */
type SharedFamilies<Ds> = keyof Listed<Ds>['inputs'] & string

/**
 * A value of the family as every revision listed takes it: the intersection
 * of their types, each in a box so that a union of its own, as `boolean`, is
 * not split apart.
 */
type InputValue<Ds, F> = (
  (
    Listed<Ds> extends infer D
      ? D extends AnyDurableWorkflow
        ? (
            box: [
              D['inputs'][F & keyof D['inputs']] extends Boundary<infer A>
                ? A
                : never,
            ],
          ) => void
        : never
      : never
  ) extends (box: infer Box) => void
    ? Box
    : never
) extends infer Box extends // Indexed, not inferred again: inferring from `[A] & [B]` takes one of them.
  [unknown]
  ? Box[0]
  : never

/**
 * Sends an input to a run of a durable workflow, named by its id or by the
 * unique key it holds (`active` unless a scope is given). The input is its
 * family and its key: what the body waits for with `d.input(family, key)`.
 * It is one commit, in the caller's transaction when there is one: a value
 * sent before the run comes to its input is kept for it, one sent while the
 * run waits completes the wait and wakes the run.
 *
 * A run is pinned to a revision, and only that revision's schema may encode
 * for it: a sender that may reach runs of older revisions gives each it
 * holds, revisions of one workflow, and the value is encoded in the commit
 * by the run's own. The value's type is one every revision given takes. A
 * run of a revision not given is refused as `other`, with `found` saying
 * which; reading `run.revision` and sending with that declaration is what is
 * left when no value fits every revision.
 *
 * The first value of an input is its value. The same value sent again is
 * answered with the receipt, `duplicate` set; any other is refused with
 * `InputRefused`, as is a send to a run that has ended or is being
 * cancelled, and one after the run's wait for it timed out. A value its
 * family's schema does not encode is a defect: nothing is written.
 */
export const send = <const Ds extends Revisions, F extends SharedFamilies<Ds>>(
  declarations: Ds,
  to: SendTo,
  family: F,
  key: string,
  value: InputValue<Ds, F>,
): Effect.Effect<Receipt, InputRefused | StorageError, Store> =>
  Effect.suspend(() => {
    const listed: readonly AnyDurableWorkflow[] = Array.isArray(declarations)
      ? declarations
      : [declarations as AnyDurableWorkflow]
    const [first] = listed
    if (!first) {
      return Effect.die(new Error('Client.send needs a durable workflow'))
    }
    const encode: Record<string, (value: unknown) => unknown> =
      Object.create(null)
    for (const declaration of listed) {
      if (declaration.name !== first.name) {
        return Effect.die(
          new Error(
            `Client.send was given revisions of [${first.name}] and of [${declaration.name}]: one workflow at a time`,
          ),
        )
      }
      const boundary = Object.hasOwn(declaration.inputs, family)
        ? (declaration.inputs[family] as Boundary<unknown>)
        : undefined
      if (!boundary) {
        return Effect.die(
          new Error(
            `Durable workflow [${declaration.name}@${declaration.revision}] takes no input [${family}]`,
          ),
        )
      }
      encode[revisionOf(declaration.revision)] = (value) =>
        boundary.encode(value)
    }
    return Engine.send({
      name: first.name,
      to:
        typeof to === 'string'
          ? { runId: to }
          : {
              unique: {
                key: to.unique,
                ...(to.scope === undefined ? {} : { scope: to.scope }),
              },
            },
      family,
      key,
      encode,
      value,
    })
  }).pipe(claimless)

/**
 * Unblocks a blocked durable run, in one commit. Each operation named, all
 * that block it when none is, has its failed work run again as the same
 * run: its completed work kept, a fresh retry budget, the same idempotency
 * keys for its handlers. A run blocked because its replay no longer matched
 * is replayed again by the code deployed now, and blocks again if that still
 * does not match. Nothing of the run's own lifetime is reset.
 *
 * Refused with `RunNotBlocked` when the run is not blocked, `StaleRunVersion`
 * when `expectedVersion` is not its version, and `BlockerNotResumable` for an
 * operation that does not block it; nothing is reopened then.
 */
export const resume = (
  runId: string,
  options: ResumeOptions = {},
): Effect.Effect<StoredRun, ResumeError | RunBusy | StorageError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    const records = yield* get(runId)
    if (!records) return yield* Effect.fail(new RunNotFound({ runId }))
    // What is found below is found for the run as it was read here: the
    // commit refuses a run that changed since.
    const expectedVersion = options.expectedVersion ?? records.run.version

    // Work reopened beside a handler of the same work still ending would run
    // twice: a run failed from outside, by its timeout, ends before its
    // handlers have. So nothing under the work may be active or claimed.
    // Read without a guard, which is sound: what failed starts again only
    // through a resume, and the commit refuses a run resumed since.
    const named = options.blockers
    const roots = records.nodes.flatMap(({ name, operation }) => {
      if (!operation?.blocked) return []
      if (named !== undefined && !named.includes(name)) return []
      const child = records.children.find(({ nodeName }) => nodeName === name)
      return child?.childRunId === undefined ? [] : [child.childRunId]
    })
    for (const root of roots) {
      const under: string[] = [root]
      for (let at = 0; at < under.length; at++) {
        let after: string | undefined
        do {
          const page = yield* store.runs({
            filter: { parentRunId: under[at]! },
            limit: FAMILY_PAGE,
            ...(after === undefined ? {} : { after }),
          })
          for (const { id, status } of page.items) {
            if (!isTerminal(status)) {
              return yield* Effect.fail(new RunBusy({ runId, busyRunId: id }))
            }
            under.push(id)
          }
          after = page.next
        } while (after !== undefined)
      }
      const [held] = yield* store.claimed(under)
      if (held !== undefined) {
        return yield* Effect.fail(new RunBusy({ runId, busyRunId: held }))
      }
    }

    return yield* claimless(
      Engine.resume(runId, { ...options, expectedVersion }),
    )
  })

/**
 * A run with its nodes, children and attempts, as stored, in the same order
 * on every store: nodes by name; children by node, a map's items by index and
 * any other by key; attempts by child, in the order they were made.
 */
export const get = (
  runId: string,
): Effect.Effect<RunRecords | undefined, StorageError, Store> =>
  Effect.flatMap(Store, (store) =>
    Effect.map(store.load(runId), (records) => records && ordered(records)),
  )

/**
 * A run and what it owns without their payloads, in the order `get` gives
 * them, and the runs it started, in the order of the children that did.
 */
export type RunDetail = {
  readonly run: RunSummary
  readonly nodes: readonly Omit<StoredNode, 'input' | 'output'>[]
  readonly children: readonly Omit<StoredChild, 'item' | 'input' | 'output'>[]
  readonly attempts: readonly Omit<StoredAttempt, 'input' | 'output'>[]
  readonly childRuns: readonly RunSummary[]
  /**
   * The detail of each run it started, by id, when asked for with
   * `children`: one level, as each holds its own `childRuns` to go deeper.
   */
  readonly childDetails?: Readonly<Record<string, RunDetail>>
}

export type DetailOptions = {
  /**
   * Reads the runs the run started whole too, a task run's attempts among
   * them: what a view of a durable run shows of each operation's work.
   */
  readonly children?: boolean
}

/**
 * How a run's definition can be shown. `saved` is the graph the run was
 * created with, in declared order and with the alternatives it never took.
 * `observed` means no trustworthy graph exists for the run: `detail` holds
 * everything known, and neither order, unused alternatives nor labels may be
 * filled in from a definition deployed today.
 */
export type RunDefinition =
  | {
      readonly source: 'saved'
      readonly graphHash: string
      readonly structure: DefinitionStructure
      /** Absent when the definition declared no labels. */
      readonly presentation?: GraphPresentation
      /** Absent for unversioned runs, which have no pinned bindings. */
      readonly revision?: RevisionManifest
    }
  | {
      readonly source: 'observed'
      /**
       * `legacy`: the run names no graph. `missing-graph`: its graph record
       * is gone. `invalid-graph`: the record is not what its hash names.
       */
      readonly reason: 'legacy' | 'missing-graph' | 'invalid-graph'
    }

export type RunInspection = {
  readonly detail: RunDetail
  readonly definition: RunDefinition
}

/** A saved revision with its graph, for showing a target no run has reached. */
export type SavedDefinition = {
  readonly revision: RevisionManifest
  readonly graph: {
    readonly graphHash: string
    readonly structure: DefinitionStructure
  }
}

const summary = ({
  input: _input,
  output: _output,
  presentation: _presentation,
  ...run
}: StoredRun): RunSummary => run

const withoutPayloads = ({ run, nodes, children, attempts }: RunRecords) => ({
  run: summary(run),
  nodes: nodes.map(({ input: _, output: __, ...node }) => node),
  children: children.map(
    ({ item: _, input: __, output: ___, ...child }) => child,
  ),
  attempts: attempts.map(({ input: _, output: __, ...attempt }) => attempt),
})

/**
 * A run's detail, with the runs it started and whatever `definitions` the
 * caller reads beside it. All are asked for before anything is ordered: a
 * plan that asks is planned again, and would order a large run twice.
 */
function detailOf(
  draft: Draft,
  stored: RunRecords,
  definitions: readonly string[] = [],
): RunDetail {
  draft.require({
    heads: stored.children.flatMap(({ childRunId }) =>
      childRunId === undefined ? [] : [childRunId],
    ),
    definitions,
  })
  const records = ordered(stored)
  return {
    ...withoutPayloads(records),
    // In the order of the children that started them.
    childRuns: records.children.flatMap(({ childRunId }) => {
      const child =
        childRunId === undefined ? undefined : draft.head(childRunId)
      return child ? [summary(child)] : []
    }),
  }
}

/**
 * A detail with the details of the runs its run started, when asked for. All
 * of them, and the heads their own details name, are asked for at once,
 * before any is made: a plan that asks is planned again, once per ask.
 */
function withChildren(
  draft: Draft,
  records: RunRecords,
  detail: RunDetail,
  children: boolean,
): RunDetail {
  if (!children) return detail
  const ids = records.children.flatMap(({ childRunId }) =>
    childRunId === undefined ? [] : [childRunId],
  )
  draft.require({ runs: ids })
  const found = ids.flatMap((id) => {
    const child = draft.records(id)
    return child ? [child] : []
  })
  draft.require({
    heads: found.flatMap(({ children: under }) =>
      under.flatMap(({ childRunId }) =>
        childRunId === undefined ? [] : [childRunId],
      ),
    ),
  })
  const childDetails: Record<string, RunDetail> = Object.create(null)
  for (const child of found) childDetails[child.run.id] = detailOf(draft, child)
  return { ...detail, childDetails }
}

/** A stored graph is trusted only when it still hashes to the key it is under. */
function verified(graphHash: string, stored: unknown) {
  try {
    const structure = parseStructure(stored)
    return hashStructure(structure) === graphHash ? structure : undefined
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
}

function definitionOf(
  run: StoredRun,
  graph: unknown,
  manifest: unknown,
): RunDefinition {
  const { kind, name, graphHash } = run
  if (graphHash === undefined) return { source: 'observed', reason: 'legacy' }
  if (graph === undefined)
    return { source: 'observed', reason: 'missing-graph' }

  const structure = verified(graphHash, graph)
  if (!structure || structure.kind !== kind || structure.name !== name) {
    return { source: 'observed', reason: 'invalid-graph' }
  }

  const presentation = run.presentation as GraphPresentation | undefined
  const revision = manifest as RevisionManifest | undefined
  return {
    source: 'saved',
    graphHash,
    structure,
    ...(presentation === undefined ? {} : { presentation }),
    // Bindings of another graph say nothing about this one.
    ...(revision?.graphHash === graphHash ? { revision } : {}),
  }
}

/**
 * A run's detail with the graph it was created with, from the store alone: it
 * needs no declaration, so a run whose code is long gone can still be shown.
 * `undefined` when no such run exists.
 */
export const inspect = (
  runId: string,
  { children = false }: DetailOptions = {},
): Effect.Effect<RunInspection | undefined, StorageError, Store> =>
  Effect.flatMap(Store, (store) =>
    store.transact(
      { runs: [runId] },
      planning((draft) => {
        const records = draft.records(runId)
        if (!records) return undefined
        const { run } = records
        const { kind, name, revision, graphHash } = run

        const graph = graphHash === undefined ? undefined : graphKey(graphHash)
        const manifest =
          revision === undefined
            ? undefined
            : revisionKey({ kind, name, revision })
        return {
          detail: withChildren(
            draft,
            records,
            detailOf(
              draft,
              records,
              [graph, manifest].filter((key) => key !== undefined),
            ),
            children,
          ),
          definition: definitionOf(
            run,
            graph && draft.definition(graph),
            manifest && draft.definition(manifest),
          ),
        }
      }),
    ),
  ).pipe(claimless)

/**
 * A saved revision and its graph, for showing a binding's target before, or
 * without, a run of it. `undefined` when the revision was never saved. It has
 * the target's structure and not its labels, which are saved with runs.
 */
export const getDefinition = (
  ref: RunnableRevision,
): Effect.Effect<
  SavedDefinition | undefined,
  DefinitionConflict | StorageError,
  Store
> =>
  Effect.flatMap(Store, (store) =>
    store.transact(
      { definitions: [revisionKey(ref)] },
      planning((draft) => {
        const revision = draft.definition(revisionKey(ref)) as
          | RevisionManifest
          | undefined
        if (!revision) return undefined
        const { graphHash } = revision
        const graph = draft.definition(graphKey(graphHash))
        return graph === undefined ? undefined : { revision, graph }
      }),
    ),
  ).pipe(
    claimless,
    Effect.flatMap((saved) => {
      if (!saved) return Effect.succeed(undefined)
      const { revision } = saved
      const { graphHash } = revision
      const refuse = (detail: string) =>
        Effect.fail(
          new DefinitionConflict({
            message: `Graph [${graphHash}] saved for ${label(ref)} ${detail}`,
          }),
        )

      const structure = verified(graphHash, saved.graph)
      if (!structure) return refuse('does not match its hash')
      if (structure.kind !== ref.kind || structure.name !== ref.name) {
        return refuse('describes another definition')
      }
      return Effect.succeed({ revision, graph: { graphHash, structure } })
    }),
  )

/** A run record alone, as stored; `undefined` when no such run exists. */
const head = (runId: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact(
      { heads: [runId] },
      planning((draft) => draft.head(runId)),
    ),
  ).pipe(claimless)

const ACTIVE: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'blocked',
  'cancelling',
]

/** How many runs of a family one read takes while a retry looks it over. */
const FAMILY_PAGE = 100

/**
 * Reopens a failed root run in place: the same run, with its id, input, tags
 * and keys, and everything it completed. Only what failed runs again, each
 * piece of work on the input its last attempt had and with a fresh retry
 * budget, and the run's timeout counts from now. Failed and cancelled runs
 * under it are reopened the same way as their parents reach them.
 *
 * `expectedVersion` refuses a retry decided on an older view of the run;
 * without one, the view is the one this call begins with. A retry is refused, not delayed, while anything of the family is still in
 * flight, so that no work starts again beside a handler that is still ending.
 */
export const retry = (
  runId: string,
  options: { readonly expectedVersion?: number } = {},
): Effect.Effect<StoredRun, RetryError | RunBusy | StorageError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    const run = yield* head(runId)
    const refusal = unretryable(runId, run, options.expectedVersion)
    if (refusal) return yield* Effect.fail(refusal)
    // What is found below is found for the run as it was read here: the
    // commit refuses one that was retried, and failed again, since.
    const expectedVersion = options.expectedVersion ?? run!.version

    // Read without a guard, which is sound for a family whose root failed:
    // nothing of it starts again but through this retry, so what is found
    // settled here stays settled until the commit below.
    const busy = (busyRunId: string) =>
      Effect.fail(new RunBusy({ runId, busyRunId }))
    const filter: RunFilter = { rootRunId: runId }
    const active = yield* store.runs({
      filter: { ...filter, status: ACTIVE },
      limit: 1,
    })
    if (active.items.length > 0) return yield* busy(active.items[0]!.id)

    let after: string | undefined
    do {
      const page = yield* store.runs({
        filter,
        limit: FAMILY_PAGE,
        ...(after === undefined ? {} : { after }),
      })
      const [held] = yield* store.claimed(page.items.map(({ id }) => id))
      if (held !== undefined) return yield* busy(held)
      after = page.next
    } while (after !== undefined)

    return yield* claimless(Engine.retry(runId, expectedVersion))
  })

/** The run a restart made, as the declaration it was resolved to types it. */
type Restarted<D> = D extends Declaration
  ? DecodedRun<InputOf<D>, OutputOf<D>>
  : never

/**
 * Starts a new root run from the stored input of one that has ended, with
 * the declaration the run was created from: its own revision, never another,
 * as only that contract is known to read its input back right. The stored
 * tags and unique constraint are applied again unless `options` replace
 * them, and the rules of `start` hold: a constraint of scope `all` conflicts
 * with the run being restarted.
 */
export const restart = <const Definitions extends readonly Declaration[]>(
  runId: string,
  options: StartOptions & {
    /** What the run may be a run of; several revisions of a name are fine. */
    readonly definitions: Definitions
  },
): Effect.Effect<
  Restarted<Definitions[number]>,
  | StartError
  | RunNotFound
  | RunNotRoot
  | RunNotTerminal
  | UnknownDefinition
  | StorageError,
  Store
> =>
  Effect.gen(function* () {
    const { definitions, ...overrides } = options
    const run = yield* head(runId)
    if (!run) return yield* Effect.fail(new RunNotFound({ runId }))
    const { kind, name, revision, status } = run
    if (!isTerminal(status)) {
      return yield* Effect.fail(new RunNotTerminal({ runId, status }))
    }
    if (run.parentRunId !== undefined) {
      return yield* Effect.fail(new RunNotRoot({ runId }))
    }

    const declaration = definitions.find(
      (known) =>
        known.kind === kind &&
        known.name === name &&
        known.revision === revision,
    )
    if (!declaration) {
      return yield* Effect.fail(
        new UnknownDefinition({
          runId,
          kind,
          name,
          ...(revision === undefined ? {} : { revision }),
        }),
      )
    }

    const restarted = yield* start(
      declaration,
      declaration.input.decode(run.input),
      {
        tags: run.tags,
        ...(run.unique === undefined ? {} : { unique: run.unique }),
        ...overrides,
      },
    )
    return restarted as Restarted<Definitions[number]>
  })

export type ListFilter = Omit<RunFilter, 'status'> & {
  /** One status or any of several; an empty list matches nothing. */
  readonly status?: RunStatus | readonly RunStatus[]
  /** 100 when omitted. */
  readonly limit?: number
  /** The `nextCursor` of an earlier page of the same filter. */
  readonly cursor?: string
}

const listed = ({ status, limit = 100, cursor, ...filter }: ListFilter) =>
  Effect.flatMap(Store, (store) =>
    store.runs({
      filter: {
        ...filter,
        ...(status === undefined
          ? {}
          : { status: typeof status === 'string' ? [status] : status }),
      },
      limit,
      ...(cursor === undefined ? {} : { after: cursor }),
    }),
  )

const cursored = <A>(next: string | undefined, runs: readonly A[]) => ({
  runs,
  ...(next === undefined ? {} : { nextCursor: next }),
})

/** Runs without their payloads, newest first, with how far their nodes are. */
export const listSummaries = (
  filter: ListFilter = {},
): Effect.Effect<
  { readonly runs: readonly ListedRun[]; readonly nextCursor?: string },
  StorageError,
  Store
> => Effect.map(listed(filter), ({ items, next }) => cursored(next, items))

/** Runs as stored, newest first. */
export const list = (
  filter: ListFilter = {},
): Effect.Effect<
  { readonly runs: readonly StoredRun[]; readonly nextCursor?: string },
  StorageError,
  Store
> =>
  Effect.gen(function* () {
    const store = yield* Store
    const { items, next } = yield* listed(filter)
    const ids = items.map(({ id }) => id)
    // A page is one read and its records another: a run that went away in
    // between is left out.
    const runs = yield* store
      .transact(
        { heads: ids },
        planning((draft) =>
          ids.flatMap((id) => {
            const run = draft.head(id)
            return run ? [run] : []
          }),
        ),
      )
      .pipe(claimless)
    return cursored(next, runs)
  })

/**
 * A run and what it owns without their payloads, and the runs it started;
 * `undefined` when no such run exists.
 */
export const getDetail = (
  runId: string,
  { children = false }: DetailOptions = {},
): Effect.Effect<RunDetail | undefined, StorageError, Store> =>
  Effect.flatMap(Store, (store) =>
    store.transact(
      { runs: [runId] },
      planning((draft): RunDetail | undefined => {
        const records = draft.records(runId)
        if (!records) return undefined
        return withChildren(draft, records, detailOf(draft, records), children)
      }),
    ),
  ).pipe(claimless)

/** One node of a run with its children and their attempts, as stored. */
export type NodeSnapshot = {
  readonly node: StoredNode
  readonly children: readonly StoredChild[]
  readonly attempts: readonly StoredAttempt[]
}

export const getNode = (
  runId: string,
  nodeName: string,
): Effect.Effect<NodeSnapshot | undefined, StorageError, Store> =>
  Effect.map(get(runId), (records) => {
    const node = records?.nodes.find(({ name }) => name === nodeName)
    if (!records || !node) return undefined
    const own = (record: { readonly nodeName: string }) =>
      record.nodeName === nodeName
    return {
      node,
      children: records.children.filter(own),
      attempts: records.attempts.filter(own),
    }
  })

export type RunFamilyEntry = {
  readonly run: Omit<ListedRun, 'origin'>
  /** The child of its parent that started the run; none for the root. */
  readonly origin?: NonNullable<ListedRun['origin']>
}

/**
 * Every run under the root of the given one, the root included and each
 * once, oldest first; none when no such run exists.
 */
export const getFamily = (
  runId: string,
): Effect.Effect<readonly RunFamilyEntry[], StorageError, Store> =>
  Effect.gen(function* () {
    const store = yield* Store
    const member = yield* head(runId)
    if (!member) return []

    const family: RunFamilyEntry[] = []
    let after: string | undefined
    do {
      const page = yield* store.runs({
        filter: { rootRunId: member.rootRunId },
        limit: FAMILY_PAGE,
        ...(after === undefined ? {} : { after }),
      })
      for (const { origin, ...run } of page.items) {
        family.push({ run, ...(origin === undefined ? {} : { origin }) })
      }
      after = page.next
    } while (after !== undefined)
    // Read newest first.
    return family.reverse()
  })

export type WatchOptions = {
  /**
   * Also gives a `change` event on every hint that something of the run's
   * family changed. Coarse and best-effort: a hint may be missing, and it
   * does not say what changed.
   */
  readonly wake?: boolean
  /**
   * Gives at most one `change` in this long after the last: the first hint
   * after a quiet time passes at once, the others in the window become one
   * event when it closes. A status change is never held back.
   */
  readonly debounceMs?: number
  /**
   * How often the run is read when no hint comes, which is what guarantees
   * that a status change is seen. 1 second when omitted.
   */
  readonly pollIntervalMs?: number
}

export type WatchEvent =
  | { readonly kind: 'change' }
  | {
      readonly kind: 'run'
      readonly status: RunStatus
      readonly error?: StoredError
    }

/**
 * The statuses a run goes through from now on, starting with the one it has,
 * and ending with the one it ends in. Empty for a run that does not exist.
 * A run reopened by a retry is watched anew: this stream ended when it failed.
 */
export const watch = (
  runId: string,
  options: WatchOptions = {},
): Stream.Stream<WatchEvent, StorageError, Store> => {
  const { wake = false, debounceMs = 0, pollIntervalMs = 1_000 } = options
  // Reading without a pause would be a loop that never rests.
  if (!(pollIntervalMs > 0)) {
    throw new Error('Watch pollIntervalMs must be positive')
  }

  return Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* Store
      const found = yield* head(runId)
      if (!found) return Stream.empty

      // Subscribed before the first status is read, so nothing committed
      // after that read goes unnoticed until the next poll.
      const hinted = yield* store.listen(familyTopic(found.rootRunId))
      const read = Effect.provideService(head(runId), Store, store)
      const hintWithin = (ms: number) =>
        Effect.raceFirst(
          Effect.as(hinted, true),
          Effect.as(Effect.sleep(ms), false),
        )

      let status: RunStatus | undefined
      let ended = false
      let lastChangeAt = -Infinity

      /** Waits for a reason to read again; true when it was a hint. */
      const waited = Effect.gen(function* () {
        if (!(yield* hintWithin(pollIntervalMs))) return false
        // Inside the window hints are collected, and the run is read as
        // often as outside it, at every hint and every poll interval: a new
        // status ends the wait at once, whether or not a hint told of it.
        for (;;) {
          const remaining =
            lastChangeAt + debounceMs - (yield* Clock.currentTimeMillis)
          if (remaining <= 0) break
          if ((yield* read)?.status !== status) break
          yield* hintWithin(Math.min(remaining, pollIntervalMs))
        }
        lastChangeAt = yield* Clock.currentTimeMillis
        return true
      })

      const pull = Effect.gen(function* () {
        for (;;) {
          if (ended) return yield* Cause.done()
          const woken = status === undefined ? false : yield* waited
          const run = yield* read
          if (!run) return yield* Cause.done()
          if (run.status !== status) {
            status = run.status
            ended = isTerminal(status)
            const { error } = run
            const event: WatchEvent = {
              kind: 'run',
              status,
              ...(error === undefined ? {} : { error }),
            }
            return [event] as const
          }
          if (wake && woken) return [{ kind: 'change' } as WatchEvent] as const
        }
      })
      return Stream.fromPull(Effect.succeed(pull))
    }),
  )
}

/** Commands set aside as dead, the earliest set aside first. */
export const listDeadCommands = (
  query: {
    readonly runId?: string
    /** 100 when omitted. */
    readonly limit?: number
    readonly cursor?: string
  } = {},
): Effect.Effect<
  { readonly commands: readonly DeadCommand[]; readonly nextCursor?: string },
  StorageError,
  Store
> =>
  Effect.flatMap(Store, (store) => {
    const { runId, limit = 100, cursor } = query
    return Effect.map(
      store.dead({
        limit,
        ...(runId === undefined ? {} : { runId }),
        ...(cursor === undefined ? {} : { after: cursor }),
      }),
      ({ items, next }) => ({
        commands: items,
        ...(next === undefined ? {} : { nextCursor: next }),
      }),
    )
  })

/**
 * Queues a dead command again, to be delivered as if for the first time.
 * `false` when no dead command has this id. Queueing is what takes it off
 * the dead: asked twice, or by two callers at once, only one queues it.
 */
export const requeueDeadCommand = (
  id: string,
): Effect.Effect<boolean, StorageError, Store> => claimless(Engine.requeue(id))

/**
 * Deletes a root run that has ended, with every run under it and all they
 * own. `deleted` is false when no run has the id. Refused for a run that is
 * not a root, and while a run of the family has not ended or a worker still
 * holds a command of one. Saved definitions are shared, and stay.
 */
export const deleteRun = (
  runId: string,
): Effect.Effect<
  { readonly deleted: boolean },
  RunNotRoot | RunBusy | StorageError,
  Store
> =>
  Engine.remove(runId).pipe(
    claimless,
    Effect.map((deleted) => ({ deleted })),
  )

/**
 * Deletes the families of the root runs that ended in one of `statuses` and
 * were not written since `olderThan`, a commit for each, until none is left
 * that may go. A family with anything still in flight stays. A `batchSize`
 * that is no non-negative safe integer throws a `RangeError` at once.
 */
export const pruneRuns = (
  params: PruneParams,
): Effect.Effect<{ readonly deleted: number }, StorageError, Store> =>
  claimless(Maintenance.pruneRuns(params))

export const schedules = {
  /** Every schedule, in the order of their names. */
  list: (): Effect.Effect<readonly StoredSchedule[], StorageError, Store> =>
    Effect.gen(function* () {
      const store = yield* Store
      const listed: StoredSchedule[] = []
      let after: string | undefined
      do {
        const page = yield* store.schedules({
          limit: 100,
          ...(after === undefined ? {} : { after }),
        })
        listed.push(...page.items)
        after = page.next
      } while (after !== undefined)
      return listed
    }),
  /**
   * Starts a run of a schedule now, as one of its slots would, whether or
   * not it is enabled. The schedule's slots are left as they are.
   */
  trigger: (
    name: string,
  ): Effect.Effect<StoredRun, UnknownSchedule | StorageError, Store> =>
    claimless(Engine.trigger(name)),
  /**
   * Turns a schedule on or off, until a reconcile says otherwise. Turned on
   * again, it fires from its next slot: what it missed is not made up for.
   */
  setEnabled: (
    name: string,
    enabled: boolean,
  ): Effect.Effect<StoredSchedule, UnknownSchedule | StorageError, Store> =>
    claimless(Engine.setScheduleEnabled(name, enabled)),
}
