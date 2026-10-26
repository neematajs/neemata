import type { Vitest } from '@effect/vitest'
import type * as Scope from 'effect/Scope'
import { describe, expect } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'

import type {
  Command,
  Route,
  RunRecords,
  StoredAttempt,
  StoredChild,
  StoredNode,
  StoredRun,
  StoredSchedule,
} from '../src/model.ts'
import type {
  Claim,
  Enqueue,
  Mutation,
  Planned,
  ReadScope,
  RunFilter,
  Snapshot,
  Store,
  UnitRead,
} from '../src/store.ts'
import { StaleClaim } from '../src/errors.ts'
import { continueRun, itemKey } from '../src/model.ts'
import { planning } from '../src/plan/draft.ts'
import { resultsKey, unitKey } from '../src/store.ts'

/**
 * What every adapter of `Store` guarantees, asserted through the service
 * alone. An adapter passes it for its own harness; nothing here knows how a
 * store keeps anything.
 */

export type StoreService = ReturnType<typeof Store.of>

export type MadeStore = {
  readonly store: StoreService
  /**
   * Has `act` begin once, as a concurrent writer, between the next planned
   * mutation and its commit, and gives the effect that waits for `act` to
   * end. A store that holds nothing while it plans runs `act` to its end in
   * that gap. One that makes writers wait goes on to commit as soon as `act`
   * waits for it, and `act` ends after the commit: the effect then gives
   * `true`, for a writer that waited. When `act` dies in the gap, the commit
   * dies of it: a crash between planning and commit.
   *
   * Left out where no writer can be concurrent: see `gap` of the harness.
   */
  readonly inGap?: (act: Effect.Effect<unknown>) => Effect.Effect<boolean>
}

export type StoreHarness<R> = {
  /** A fresh, empty store. */
  readonly make: (options?: {
    readonly maxDeliveries?: number
  }) => Effect.Effect<MadeStore, never, R | Scope.Scope>
  /** Lets `ms` pass on the clock the store reads. */
  readonly elapse: (ms: number) => Effect.Effect<void>
  /** Whether hints are delivered here. A store that gives none is polled. */
  readonly hints: boolean
  /**
   * Whether `make` gives an `inGap`. Without one the tests that need it are
   * skipped, and seen to be.
   */
  readonly gap: boolean
}

const FLOW = 'contract.flow'
/** Long enough that no test outlives it by accident. */
const LEASE = 60_000
/** A lease or delay a test waits out. */
const SHORT = 200
const PAST_SHORT = 300

const commit = <A>(mutation: Mutation, result: A): Planned<A> => ({
  _tag: 'Commit',
  mutation,
  result,
})

const stored = (id: string, now: number, patch?: Partial<StoredRun>) =>
  ({
    id,
    kind: 'workflow',
    name: FLOW,
    status: 'running',
    input: { n: 1 },
    rootRunId: id,
    tags: {},
    version: 1,
    activeSince: now,
    createdAt: now,
    updatedAt: now,
    ...patch,
  }) satisfies StoredRun

const create = (store: StoreService, patch?: Partial<StoredRun>) =>
  store.transact({}, (snapshot) => {
    const run = stored(snapshot.id('run'), snapshot.now, patch)
    return commit({ runs: [run] }, run)
  })

/** Ids the store would give a plan, for runs a test never writes. */
const freshIds = (store: StoreService, count: number) =>
  store.transact({}, (snapshot) =>
    commit(
      {},
      Array.from({ length: count }, () => snapshot.id('run')),
    ),
  )

const wake = (run: StoredRun, availableAt?: number): Enqueue => ({
  command: continueRun(run),
  dedupe: `continue:${run.id}`,
  ...(availableAt === undefined ? {} : { availableAt }),
})

const enqueue = (store: StoreService, ...entries: readonly Enqueue[]) =>
  store.transact({}, () => commit({ enqueue: entries }, undefined))

/** Claims passes: the lane most of these tests queue into. */
const claims = (
  store: StoreService,
  options: {
    readonly routes?: readonly Route[]
    readonly limit?: number
    readonly leaseMs?: number
  } = {},
) =>
  store.claim({
    lanes: [
      { kind: 'continueRun', routes: options.routes ?? [{ name: FLOW }] },
    ],
    limit: options.limit ?? 10,
    leaseMs: options.leaseMs ?? LEASE,
  })

/** An attempt of the task run `run` is: queued in the lane of tasks. */
const attempt = (run: StoredRun): Command => ({
  kind: 'runTask',
  name: run.name,
  runId: run.id,
  nodeName: '$task',
  childKey: '$self',
  attemptId: 'attempt',
  input: { n: 1 },
  retry: { attempts: 2 },
})

const runIds = (claimed: readonly Claim[]) =>
  claimed.map(({ command }) => command.runId)

const ack = (store: StoreService, ...claimed: readonly Claim[]) =>
  store.transact({}, () => commit({ ack: claimed }, undefined))

const now = (store: StoreService) =>
  store.transact({}, (snapshot) => commit({}, snapshot.now))

const view = <A>(
  store: StoreService,
  scope: ReadScope,
  read: (snapshot: Snapshot) => A,
) => store.transact(scope, (snapshot) => commit({}, read(snapshot)))

const holder = (store: StoreService, key: string) =>
  view(store, { keys: [key] }, (snapshot) => snapshot.keys.get(key))

/** Order is not part of the contract: records are compared as sets. */
function sorted(records: RunRecords | undefined) {
  if (!records) return records
  const by = <A>(key: (record: A) => string, list: readonly A[]) =>
    list.toSorted((a, b) => key(a).localeCompare(key(b)))
  return {
    run: records.run,
    nodes: by((node) => node.name, records.nodes),
    children: by(
      (child) => `${child.nodeName}/${child.childKey}`,
      records.children,
    ),
    attempts: by((attempt) => attempt.id, records.attempts),
  }
}

const died = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause)

/** Lets a waiting fiber run, on whichever clock the test has. */
const settle = <R>(harness: StoreHarness<R>) => harness.elapse(50)

export function storeContract<R>(
  it: { readonly effect: Vitest.Tester<R | Scope.Scope> },
  harness: StoreHarness<R>,
) {
  const CONCURRENT = 12
  /** A test of what happens in the gap between a plan and its commit. */
  const gapped = it.effect.skipIf(!harness.gap)

  describe('commits', () => {
    it.effect('gives back every record as it was written', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const parent = yield* create(store)
        const written = yield* store.transact(
          { runs: [parent.id] },
          ({ id, now }) => {
            const node: StoredNode = {
              runId: parent.id,
              name: 'step',
              kind: 'mapTask',
              status: 'waiting',
              input: [1, null],
              output: null,
              error: { name: 'Oops', message: 'no', cause: { message: 'why' } },
              selectedCase: 'case',
              version: 2,
              createdAt: now,
              updatedAt: now + 1,
            }
            const run = stored(id('run'), now, {
              kind: 'task',
              status: 'completed',
              input: null,
              output: { deep: { nothing: null, list: [] } },
              error: { message: 'failed' },
              parentRunId: parent.id,
              parentNodeName: node.name,
              parentRoute: { name: FLOW, revision: 'p1' },
              rootRunId: parent.id,
              tags: { tenant: 'a' },
              headers: { traceparent: '00-abc-def-01', empty: '' },
              idempotencyKey: ['order', 1, { b: 2 }],
              unique: { key: ['k'], scope: 'all', behavior: 'join' },
              revision: 'r1',
              graphHash: 'hash',
              presentation: { title: 'Run' },
              version: 7,
              activeSince: now - 5,
            })
            const attempt: StoredAttempt = {
              id: id('attempt'),
              runId: parent.id,
              nodeName: node.name,
              childKey: 'item:0',
              status: 'timedOut',
              attemptNumber: 3,
              retryAttemptNumber: 2,
              input: 'text',
              output: 0,
              error: { message: 'slow' },
              dispatchedAt: now,
              completedAt: now + 2,
            }
            const child: StoredChild = {
              runId: parent.id,
              nodeName: node.name,
              childKey: 'item:0',
              kind: 'task',
              status: 'running',
              ordinal: 0,
              item: null,
              input: false,
              output: [],
              error: { message: 'child' },
              childRunId: run.id,
              cancellation: 'detach',
              currentAttemptId: attempt.id,
              attemptCount: 3,
              version: 4,
              createdAt: now,
              updatedAt: now,
            }
            // A node of few fields: what is not set stays unset.
            const bare: StoredNode = {
              runId: parent.id,
              name: 'bare',
              kind: 'activity',
              status: 'pending',
              version: 1,
              createdAt: now,
              updatedAt: now,
            }
            return commit(
              {
                runs: [run],
                nodes: [node, bare],
                children: [child],
                attempts: [attempt],
              },
              { run, node, bare, child, attempt },
            )
          },
        )

        expect(sorted(yield* store.load(parent.id))).toEqual({
          run: parent,
          nodes: [written.bare, written.node],
          children: [written.child],
          attempts: [written.attempt],
        })
        expect(yield* store.load(written.run.id)).toEqual({
          run: written.run,
          nodes: [],
          children: [],
          attempts: [],
        })
      }),
    )

    it.effect('a record written again replaces the one stored', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store, { output: { a: 1 }, tags: { a: 'b' } })
        const { output: _output, ...rest } = run
        const next = {
          ...rest,
          status: 'failed' as const,
          version: 2,
          tags: {},
        }
        yield* store.transact({ heads: [run.id] }, () =>
          commit({ runs: [next] }, undefined),
        )
        // Whole records: a field the new version lacks is gone.
        expect((yield* store.load(run.id))?.run).toEqual(next)

        // Of two versions in one mutation, the last is the record.
        const last = { ...next, version: 4 }
        yield* store.transact({ heads: [run.id] }, () =>
          commit({ runs: [{ ...next, version: 3 }, last] }, undefined),
        )
        expect((yield* store.load(run.id))?.run).toEqual(last)
      }),
    )

    it.effect('keeps apart the records whose keys only look alike', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        // Each pair is one text when its parts are joined by what they hold.
        const pairs = [
          ['a\nb', 'c'],
          ['a', 'b\nc'],
          ['a/b', 'c'],
          ['a', 'b/c'],
        ] as const
        yield* store.transact({ runs: [run.id] }, ({ now }) => {
          const record = { runId: run.id, version: 1 } as const
          const times = { createdAt: now, updatedAt: now }
          return commit(
            {
              nodes: Array.from(
                new Set(pairs.map(([nodeName]) => nodeName)),
                (name): StoredNode => ({
                  ...record,
                  ...times,
                  name,
                  kind: 'mapTask',
                  status: 'running',
                }),
              ),
              children: pairs.map(
                ([nodeName, childKey]): StoredChild => ({
                  ...record,
                  ...times,
                  nodeName,
                  childKey,
                  kind: 'task',
                  status: 'pending',
                  attemptCount: 0,
                }),
              ),
            },
            undefined,
          )
        })

        const { children } = (yield* store.load(run.id))!
        expect(
          children.map(({ nodeName, childKey }) => [nodeName, childKey]),
        ).toEqual(expect.arrayContaining(pairs.map((pair) => [...pair])))
        expect(children).toHaveLength(pairs.length)
      }),
    )

    it.effect('an id in another spelling names no run', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        yield* enqueue(store, wake(run))
        yield* claims(store)
        const other = run.id.toUpperCase()
        expect(other).not.toBe(run.id)

        // Wherever the id is given: an id is the text the store gave.
        expect(yield* store.load(other)).toBeUndefined()
        expect(
          yield* view(
            store,
            { runs: [other], heads: [other], families: [other] },
            (snapshot) => [
              snapshot.runs.get(other),
              snapshot.heads.get(other),
              snapshot.families.get(other),
            ],
          ),
        ).toEqual([undefined, undefined, undefined])
        expect(yield* store.claimed([other, run.id])).toEqual([run.id])
        for (const filter of [{ rootRunId: other }, { parentRunId: other }]) {
          expect((yield* store.runs({ limit: 10, filter })).items).toEqual([])
        }
        expect((yield* store.dead({ runId: other, limit: 10 })).items).toEqual(
          [],
        )

        // And nothing is written under it to the run it does not name.
        const written = yield* Effect.exit(
          store.transact({ runs: [other] }, ({ now }) => {
            const node: StoredNode = {
              runId: other,
              name: 'step',
              kind: 'activity',
              status: 'pending',
              version: 1,
              createdAt: now,
              updatedAt: now,
            }
            return commit({ nodes: [node] }, undefined)
          }),
        )
        expect(died(written)).toBe(true)
        expect(yield* store.load(run.id)).toEqual({
          run,
          nodes: [],
          children: [],
          attempts: [],
        })
      }),
    )

    it.effect(
      'applies nothing of a mutation whose acknowledgement is stale',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const run = yield* create(store)
          yield* enqueue(store, wake(run))
          const [claim] = yield* claims(store)
          yield* store.release(claim!)

          const [nextId] = yield* freshIds(store, 1)
          const error = yield* Effect.flip(
            store.transact(
              { runs: [run.id], keys: ['k'], definitions: ['d'] },
              ({ now }) =>
                commit(
                  {
                    runs: [
                      { ...run, status: 'completed' },
                      stored(nextId!, now),
                    ],
                    nodes: [
                      {
                        runId: run.id,
                        name: 'step',
                        kind: 'activity',
                        status: 'pending',
                        version: 1,
                        createdAt: now,
                        updatedAt: now,
                      },
                    ],
                    keys: [{ op: 'acquire', key: 'k', runId: run.id }],
                    definitions: [{ key: 'd', value: 1 }],
                    enqueue: [{ command: continueRun(run), dedupe: 'another' }],
                    ack: [claim!],
                  },
                  undefined,
                ),
            ),
          )

          expect(error).toEqual(new StaleClaim({ commandId: claim!.id }))
          expect(yield* store.load(run.id)).toEqual({
            run,
            nodes: [],
            children: [],
            attempts: [],
          })
          expect(yield* store.load(nextId!)).toBeUndefined()
          expect(yield* holder(store, 'k')).toBeUndefined()
          expect(
            yield* view(store, { definitions: ['d'] }, (snapshot) =>
              snapshot.definitions.get('d'),
            ),
          ).toBeUndefined()
          // Only the command that was given back waits.
          expect(yield* claims(store)).toHaveLength(1)
        }),
    )

    it.effect('a plan that refuses or throws writes nothing', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)

        const refused = yield* Effect.flip(
          store.transact(
            { runs: [run.id] },
            (): Planned<never, 'no'> => ({
              _tag: 'Fail',
              error: 'no',
            }),
          ),
        )
        expect(refused).toBe('no')

        const thrown = yield* Effect.exit(
          store.transact({ runs: [run.id] }, () => {
            throw new Error('broken plan')
          }),
        )
        expect(died(thrown)).toBe(true)

        // Neither left anything behind, a lock included.
        yield* store.transact({ runs: [run.id] }, () =>
          commit({ runs: [{ ...run, version: 2 }] }, undefined),
        )
        expect((yield* store.load(run.id))?.run.version).toBe(2)
      }),
    )

    gapped('a failure between planning and commit leaves nothing', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* harness.make()
        const run = yield* create(store)

        inGap!(Effect.die('lost connection'))
        const exit = yield* Effect.exit(
          store.transact({ runs: [run.id], keys: ['k'] }, () =>
            commit(
              {
                runs: [{ ...run, version: 2 }],
                keys: [{ op: 'acquire', key: 'k', runId: run.id }],
                enqueue: [wake(run)],
              },
              undefined,
            ),
          ),
        )

        expect(died(exit)).toBe(true)
        expect((yield* store.load(run.id))?.run).toEqual(run)
        expect(yield* holder(store, 'k')).toBeUndefined()
        expect(yield* claims(store)).toEqual([])
      }),
    )

    it.effect('loads more when a plan needs it, and keeps what it had', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const first = yield* create(store)
        const second = yield* create(store)
        const [missing] = yield* freshIds(store, 1)
        yield* store.transact({ keys: ['held'], definitions: ['saved'] }, () =>
          commit(
            {
              keys: [{ op: 'acquire', key: 'held', runId: first.id }],
              definitions: [{ key: 'saved', value: { graph: [1] } }],
            },
            undefined,
          ),
        )

        const needs: ReadScope[] = [
          { heads: [second.id, missing!] },
          { keys: ['held', 'free'] },
          { definitions: ['saved', 'unsaved'] },
          { runs: [missing!] },
        ]
        let calls = 0
        const seen = yield* store.transact(
          { runs: [first.id] },
          (snapshot): Planned<Snapshot> => {
            const need = needs[calls++]
            return need ? { _tag: 'Need', scope: need } : commit({}, snapshot)
          },
        )

        expect(calls).toBe(5)
        expect(seen.runs.get(first.id)?.run).toEqual(first)
        expect(seen.heads.get(second.id)).toEqual(second)
        // Loaded and absent is an entry of `undefined`; not loaded is none.
        expect(Array.from(seen.heads)).toContainEqual([missing, undefined])
        expect(Array.from(seen.runs)).toContainEqual([missing, undefined])
        expect(Array.from(seen.keys)).toEqual([
          ['held', first.id],
          ['free', undefined],
        ])
        expect(Array.from(seen.definitions)).toEqual([
          ['saved', { graph: [1] }],
          ['unsaved', undefined],
        ])
        expect(seen.heads.has(first.id)).toBe(false)
      }),
    )

    it.effect(
      'gives plans the time of its clock and ids never given before',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const before = yield* now(store)
          yield* harness.elapse(PAST_SHORT)
          expect(yield* now(store)).toBeGreaterThanOrEqual(before + PAST_SHORT)
          expect(new Set(yield* freshIds(store, 50)).size).toBe(50)
        }),
    )
  })

  describe('guards', () => {
    // Each writer adds one to what it read. A writer that planned on a view
    // another had already changed would write that other's update away.
    const bump = (
      store: StoreService,
      scope: ReadScope,
      runId: string,
      /** The versions it planned on, one for each time it was planned. */
      seen: number[] = [],
    ) =>
      store.transact(scope, (snapshot) => {
        const run = snapshot.runs.get(runId)?.run ?? snapshot.heads.get(runId)!
        seen.push(run.version)
        return commit(
          { runs: [{ ...run, version: run.version + 1 }] },
          undefined,
        )
      })

    const scopes = {
      'a loaded run': (id: string): ReadScope => ({ runs: [id] }),
      'a loaded head': (id: string): ReadScope => ({ heads: [id] }),
    }
    for (const [loaded, scope] of Object.entries(scopes)) {
      it.effect(`concurrent writers of ${loaded} lose no update`, () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const run = yield* create(store)
          yield* Effect.all(
            Array.from({ length: CONCURRENT }, () =>
              bump(store, scope(run.id), run.id),
            ),
            { concurrency: 'unbounded' },
          )
          expect((yield* store.load(run.id))?.run.version).toBe(1 + CONCURRENT)
        }),
      )
    }

    it.effect('a write to what a run owns is a change to the run', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        // Each writer adds the node after the ones it read.
        const add = store.transact({ runs: [run.id] }, (snapshot) => {
          const { nodes } = snapshot.runs.get(run.id)!
          return commit(
            {
              nodes: [
                {
                  runId: run.id,
                  name: `step-${nodes.length}`,
                  kind: 'activity',
                  status: 'pending',
                  version: 1,
                  createdAt: snapshot.now,
                  updatedAt: snapshot.now,
                },
              ],
            },
            undefined,
          )
        })
        yield* Effect.all(
          Array.from({ length: CONCURRENT }, () => add),
          { concurrency: 'unbounded' },
        )
        expect((yield* store.load(run.id))?.nodes).toHaveLength(CONCURRENT)
      }),
    )

    it.effect('one of the concurrent takers of a free key gets it', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        // Absence is guarded too: every taker saw the key free or held.
        const take = store.transact({ keys: ['k'] }, (snapshot) => {
          const held = snapshot.keys.get('k')
          if (held !== undefined) return commit({}, { held, created: false })
          const run = stored(snapshot.id('run'), snapshot.now)
          return commit(
            {
              runs: [run],
              keys: [{ op: 'acquire', key: 'k', runId: run.id }],
            },
            { held: run.id, created: true },
          )
        })
        const taken = yield* Effect.all(
          Array.from({ length: CONCURRENT }, () => take),
          { concurrency: 'unbounded' },
        )

        expect(taken.filter(({ created }) => created)).toHaveLength(1)
        expect(new Set(taken.map(({ held }) => held)).size).toBe(1)
        expect(yield* holder(store, 'k')).toBe(taken[0]!.held)
      }),
    )

    it.effect(
      'a released key is free, and the last change to a key stands',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const first = yield* create(store)
          const second = yield* create(store)
          const change = (op: 'acquire' | 'release', runId: string) =>
            ({ op, key: 'k', runId }) as const
          const apply = (...keys: readonly ReturnType<typeof change>[]) =>
            store.transact({ keys: ['k'] }, () => commit({ keys }, undefined))

          yield* apply(change('acquire', first.id))
          expect(yield* holder(store, 'k')).toBe(first.id)
          yield* apply(change('release', first.id))
          expect(yield* holder(store, 'k')).toBeUndefined()
          yield* apply(
            change('acquire', first.id),
            change('release', first.id),
            change('acquire', second.id),
          )
          expect(yield* holder(store, 'k')).toBe(second.id)
        }),
    )

    it.effect('one of the concurrent savers of a definition saves it', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const save = (value: number) =>
          store.transact({ definitions: ['d'] }, (snapshot) => {
            const saved = snapshot.definitions.get('d')
            return saved === undefined
              ? commit({ definitions: [{ key: 'd', value }] }, value)
              : commit({}, saved)
          })
        const saved = yield* Effect.all(
          Array.from({ length: CONCURRENT }, (_, value) => save(value)),
          { concurrency: 'unbounded' },
        )
        expect(new Set(saved).size).toBe(1)

        // Immutable: a plan that writes over what it saw is a broken plan.
        const again = yield* Effect.exit(
          store.transact({ definitions: ['d'] }, () =>
            commit({ definitions: [{ key: 'd', value: 'other' }] }, undefined),
          ),
        )
        expect(died(again)).toBe(true)
        expect(yield* save(-1)).toBe(saved[0])
      }),
    )

    it.effect('refuses to write what the plan did not load', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)

        const overRun = yield* Effect.exit(
          store.transact({}, () =>
            commit({ runs: [{ ...run, version: 9 }] }, undefined),
          ),
        )
        const overKey = yield* Effect.exit(
          store.transact({}, () =>
            commit(
              { keys: [{ op: 'acquire', key: 'k', runId: run.id }] },
              undefined,
            ),
          ),
        )
        const overDefinition = yield* Effect.exit(
          store.transact({}, () =>
            commit({ definitions: [{ key: 'd', value: 1 }] }, undefined),
          ),
        )

        expect([overRun, overKey, overDefinition].map(died)).toEqual([
          true,
          true,
          true,
        ])
        expect((yield* store.load(run.id))?.run).toEqual(run)
        expect(yield* holder(store, 'k')).toBeUndefined()
      }),
    )

    // A store keeps a plan and a writer that comes in its gap apart in one
    // of two ways: the plan runs again on what the writer left, or the
    // writer waits and plans on what the commit left. Either way one of them
    // planned on the other's work, and nothing either wrote is lost.
    describe('a writer between a plan and its commit', () => {
      const scopes = {
        'of a loaded run': (id: string): ReadScope => ({ runs: [id] }),
        'of a loaded head': (id: string): ReadScope => ({ heads: [id] }),
      }
      for (const [loaded, scope] of Object.entries(scopes)) {
        gapped(loaded, () =>
          Effect.gen(function* () {
            const { store, inGap } = yield* harness.make()
            const run = yield* create(store)
            const mine: number[] = []
            const theirs: number[] = []
            const acted = inGap!(
              Effect.orDie(bump(store, { runs: [run.id] }, run.id, theirs)),
            )
            yield* bump(store, scope(run.id), run.id, mine)
            yield* acted

            expect(new Set([mine.at(-1), theirs.at(-1)])).toEqual(
              new Set([1, 2]),
            )
            expect((yield* store.load(run.id))?.run.version).toBe(3)
          }),
        )
      }

      gapped('of a run that was absent', () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          const [id] = yield* freshIds(store, 1)
          // The writer creates the run without having loaded it, as a plan
          // does that made the id itself.
          let theirs: Exit.Exit<unknown, unknown> | undefined
          const acted = inGap!(
            Effect.map(
              Effect.exit(
                store.transact({}, ({ now }) =>
                  commit({ runs: [stored(id!, now, { version: 10 })] }, 0),
                ),
              ),
              (exit) => void (theirs = exit),
            ),
          )
          yield* store.transact({ heads: [id!] }, (snapshot) => {
            const found = snapshot.heads.get(id!)
            const run = found
              ? { ...found, version: found.version + 1 }
              : stored(id!, snapshot.now)
            return commit({ runs: [run] }, undefined)
          })
          yield* acted

          // Created first, the writer's run is what the plan then adds to.
          // Come second, the writer finds a run it did not load: refused.
          const first = Exit.isSuccess(theirs!)
          if (!first) expect(died(theirs!)).toBe(true)
          expect((yield* store.load(id!))?.run.version).toBe(first ? 11 : 1)
        }),
      )

      gapped('of a key that was absent', () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          const take = store.transact({ keys: ['k'] }, (snapshot) => {
            const held = snapshot.keys.get('k')
            if (held !== undefined) return commit({}, { held, created: false })
            const run = stored(snapshot.id('run'), snapshot.now)
            return commit(
              {
                runs: [run],
                keys: [{ op: 'acquire', key: 'k', runId: run.id }],
              },
              { held: run.id, created: true },
            )
          })
          let theirs: { held: string; created: boolean } | undefined
          const acted = inGap!(
            Effect.orDie(Effect.map(take, (taken) => void (theirs = taken))),
          )
          const mine = yield* take
          yield* acted

          expect(new Set([mine.created, theirs!.created])).toEqual(
            new Set([false, true]),
          )
          expect(mine.held).toBe(theirs!.held)
          expect(yield* holder(store, 'k')).toBe(mine.held)
        }),
      )

      gapped('of a definition that was absent', () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          const save = (value: string) =>
            store.transact({ definitions: ['d'] }, (snapshot) => {
              const saved = snapshot.definitions.get('d')
              return saved === undefined
                ? commit({ definitions: [{ key: 'd', value }] }, value)
                : commit({}, saved)
            })
          let theirs: unknown
          const acted = inGap!(
            Effect.orDie(
              Effect.map(save('theirs'), (saved) => void (theirs = saved)),
            ),
          )
          const mine = yield* save('mine')
          yield* acted

          // One saved it, and the other was shown what it saved.
          expect(mine).toBe(theirs)
          expect(
            yield* view(store, { definitions: ['d'] }, (snapshot) =>
              snapshot.definitions.get('d'),
            ),
          ).toBe(mine)
        }),
      )
    })
  })

  describe('units', () => {
    /**
     * A run whose `step` has a child with two attempts, the second current,
     * and whose `other` has a child with one.
     */
    const owning = Effect.fnUntraced(function* (store: StoreService) {
      const run = yield* create(store)
      return yield* store.transact({ runs: [run.id] }, ({ id, now }) => {
        const node = (name: string): StoredNode => ({
          runId: run.id,
          name,
          kind: 'activity',
          status: 'running',
          input: { name },
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        const attempt = (
          nodeName: string,
          attemptNumber: number,
          status: StoredAttempt['status'],
        ): StoredAttempt => ({
          id: id('attempt'),
          runId: run.id,
          nodeName,
          childKey: '$self',
          status,
          attemptNumber,
          retryAttemptNumber: attemptNumber,
          input: { nodeName, attemptNumber },
          dispatchedAt: now,
        })
        const child = (nodeName: string, current: StoredAttempt) =>
          ({
            runId: run.id,
            nodeName,
            childKey: '$self',
            kind: 'activity',
            status: 'running',
            currentAttemptId: current.id,
            attemptCount: current.attemptNumber,
            version: 1,
            createdAt: now,
            updatedAt: now,
          }) satisfies StoredChild
        const first = attempt('step', 1, 'failed')
        const second = attempt('step', 2, 'started')
        const theirs = attempt('other', 1, 'started')
        const written = {
          run,
          step: node('step'),
          other: node('other'),
          self: child('step', second),
          sibling: child('other', theirs),
          first,
          second,
          theirs,
        }
        return commit(
          {
            nodes: [written.step, written.other],
            children: [written.self, written.sibling],
            attempts: [first, second, theirs],
          },
          written,
        )
      })
    })

    it.effect('loads a unit by its keys, each record found or absent', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { run, step, self, first, second, theirs } = yield* owning(store)
        const [nothing] = yield* freshIds(store, 1)
        const of = (unit: Omit<UnitRead, 'runId'>, runId = run.id) => ({
          runId,
          ...unit,
        })
        const asked = [
          of({ nodeName: 'step', childKey: '$self', attemptId: first.id }),
          of({ nodeName: 'step', childKey: '$self' }),
          // An attempt of another child is none of this one's.
          of({ nodeName: 'step', childKey: '$self', attemptId: theirs.id }),
          of({ nodeName: 'step', childKey: '$self', attemptId: nothing! }),
          of({
            nodeName: 'step',
            childKey: '$self',
            attemptId: first.id.toUpperCase(),
          }),
          of({ nodeName: 'step', childKey: 'item:0' }),
          // Nor is an attempt of a child that is not there.
          of({ nodeName: 'step', childKey: 'item:0', attemptId: first.id }),
          of({ nodeName: 'none', childKey: '$self' }),
          of({ nodeName: 'step', childKey: '$self' }, nothing!),
          of({ nodeName: 'step', childKey: '$self' }, run.id.toUpperCase()),
        ]
        const seen = yield* view(store, { units: asked }, (snapshot) => ({
          units: asked.map((unit) => snapshot.units.get(unitKey(unit))),
          runs: snapshot.runs.size,
          heads: snapshot.heads.size,
        }))

        const found = { run, node: step, child: self }
        const absent = {
          run: undefined,
          node: undefined,
          child: undefined,
          attempt: undefined,
        }
        expect(seen.units).toStrictEqual([
          { ...found, attempt: first },
          { ...found, attempt: second },
          { ...found, attempt: undefined },
          { ...found, attempt: undefined },
          { ...found, attempt: undefined },
          { ...absent, run, node: step },
          { ...absent, run, node: step },
          { ...absent, run },
          absent,
          absent,
        ])
        // Nothing else of the run is loaded, not even as absent: what the
        // units did not read is not known to be missing.
        expect([seen.runs, seen.heads]).toEqual([0, 0])
      }),
    )

    it.effect(
      'writes of a unit only what it found, and attempts it adds to its child',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const written = yield* owning(store)
          const { run, step, other, self, sibling, first, second, theirs } =
            written
          const unit: UnitRead = {
            runId: run.id,
            nodeName: 'step',
            childKey: '$self',
            attemptId: second.id,
          }
          const [foreign] = yield* freshIds(store, 1)
          const write = (
            mutation: (snapshot: Snapshot) => Mutation,
            units: readonly UnitRead[] = [unit],
          ) =>
            Effect.exit(
              store.transact({ units }, (snapshot) =>
                commit(mutation(snapshot), undefined),
              ),
            )
          const bumped = <Stored extends { readonly version: number }>(
            record: Stored,
          ) => ({ ...record, version: record.version + 1 })
          const added = (id: string, nodeName = 'step'): StoredAttempt => ({
            ...second,
            id,
            nodeName,
            attemptNumber: 3,
          })

          const refused = yield* Effect.all([
            // Of the same run, and not read: the guard of the run is no view.
            write(() => ({ nodes: [bumped(other)] })),
            write(() => ({ children: [bumped(sibling)] })),
            write(() => ({ attempts: [{ ...first, status: 'cancelled' }] })),
            write(() => ({ attempts: [{ ...theirs, status: 'cancelled' }] })),
            // A child the unit found absent is not the unit's to create.
            write(
              () => ({ children: [{ ...self, childKey: 'item:0' }] }),
              [{ ...unit, childKey: 'item:0' }],
            ),
            // An id the snapshot did not give may name a stored attempt.
            write(() => ({ attempts: [added(foreign!)] })),
            // Nor is a child it did not read the unit's to add to.
            write(({ id }) => ({ attempts: [added(id('attempt'), 'other')] })),
          ])
          expect(refused.map(died)).toEqual(refused.map(() => true))
          expect(sorted(yield* store.load(run.id))).toEqual(
            sorted({
              run,
              nodes: [step, other],
              children: [self, sibling],
              attempts: [first, second, theirs],
            }),
          )

          const accepted = yield* store.transact(
            { units: [unit] },
            (snapshot) => {
              const found = snapshot.units.get(unitKey(unit))!
              const successor = added(snapshot.id('attempt'))
              const mutation = {
                runs: [bumped(found.run!)],
                nodes: [bumped(found.node!)],
                children: [
                  { ...bumped(found.child!), currentAttemptId: successor.id },
                ],
                attempts: [
                  { ...found.attempt!, status: 'failed' as const },
                  successor,
                ],
              }
              return commit(mutation, mutation)
            },
          )
          expect(sorted(yield* store.load(run.id))).toEqual(
            sorted({
              run: accepted.runs[0]!,
              nodes: [accepted.nodes[0]!, other],
              children: [accepted.children[0]!, sibling],
              attempts: [first, theirs, ...accepted.attempts],
            }),
          )
        }),
    )

    // Each writer adds one to the version of the child it read.
    const bumpChild = (
      store: StoreService,
      scope: ReadScope,
      unit: UnitRead,
      seen: number[] = [],
    ) =>
      store.transact(scope, (snapshot) => {
        const child =
          snapshot.units.get(unitKey(unit))?.child ??
          snapshot.runs
            .get(unit.runId)!
            .children.find(({ nodeName }) => nodeName === unit.nodeName)!
        seen.push(child.version)
        return commit(
          { children: [{ ...child, version: child.version + 1 }] },
          undefined,
        )
      })

    it.effect('concurrent writers of a unit lose no update', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { run, self } = yield* owning(store)
        const unit = { runId: run.id, nodeName: 'step', childKey: '$self' }
        yield* Effect.all(
          Array.from({ length: CONCURRENT }, () =>
            bumpChild(store, { units: [unit] }, unit),
          ),
          { concurrency: 'unbounded' },
        )
        const { children } = (yield* store.load(run.id))!
        expect(children.find(({ nodeName }) => nodeName === 'step')).toEqual({
          ...self,
          version: self.version + CONCURRENT,
        })
      }),
    )

    gapped('a writer of the whole run between a unit plan and its commit', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* harness.make()
        const { run, self } = yield* owning(store)
        const unit = { runId: run.id, nodeName: 'step', childKey: '$self' }
        const mine: number[] = []
        const theirs: number[] = []
        const acted = inGap!(
          Effect.orDie(bumpChild(store, { runs: [run.id] }, unit, theirs)),
        )
        yield* bumpChild(store, { units: [unit] }, unit, mine)
        yield* acted

        // One of them planned on what the other wrote.
        expect(new Set([mine.at(-1), theirs.at(-1)])).toEqual(
          new Set([self.version, self.version + 1]),
        )
        const { children } = (yield* store.load(run.id))!
        expect(
          children.find(({ nodeName }) => nodeName === 'step')?.version,
        ).toBe(self.version + 2)
      }),
    )
  })

  describe('open reads', () => {
    /**
     * A run whose nodes are: `done`, an activity that ended, with a child of
     * two attempts; `prior`, a map that ended; `each`, a map under way of
     * twelve items, of which 1, 4 and 6 are under way and 2, 10 and 11
     * wait; `both`, a parallel node of a member done and one running, each
     * with attempts; and `hidden`, a map under way with one item waiting.
     */
    const opening = Effect.fnUntraced(function* (store: StoreService) {
      const run = yield* create(store)
      return yield* store.transact({ runs: [run.id] }, ({ id, now }) => {
        const node = (
          name: string,
          kind: StoredNode['kind'],
          status: StoredNode['status'],
          fields: Partial<StoredNode> = {},
        ): StoredNode => ({
          runId: run.id,
          name,
          kind,
          status,
          version: 1,
          createdAt: now,
          updatedAt: now,
          ...fields,
        })
        const child = (
          nodeName: string,
          childKey: string,
          status: StoredChild['status'],
          fields: Partial<StoredChild> = {},
        ): StoredChild => ({
          runId: run.id,
          nodeName,
          childKey,
          kind: 'task',
          status,
          attemptCount: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
          ...fields,
        })
        const attempt = (
          nodeName: string,
          childKey: string,
          attemptNumber: number,
          status: StoredAttempt['status'],
        ): StoredAttempt => ({
          id: id('attempt'),
          runId: run.id,
          nodeName,
          childKey,
          status,
          attemptNumber,
          retryAttemptNumber: attemptNumber,
          input: { nodeName, attemptNumber },
          dispatchedAt: now,
        })
        const items = Array.from({ length: 12 }, (_, index) =>
          index === 3 ? null : { index, nested: { list: [index] } },
        )
        const standing: Record<number, StoredChild['status']> = {
          1: 'running',
          2: 'pending',
          3: 'failed',
          4: 'waiting',
          6: 'cancelling',
          10: 'pending',
          11: 'pending',
        }
        const history = attempt('done', '$self', 1, 'failed')
        const last = attempt('done', '$self', 2, 'completed')
        const aFirst = attempt('both', 'member:a', 1, 'failed')
        const aLast = attempt('both', 'member:a', 2, 'completed')
        const bOnly = attempt('both', 'member:b', 1, 'started')
        const written = {
          run,
          items,
          done: node('done', 'activity', 'completed', {
            input: { n: 1 },
            output: { x: 1 },
          }),
          prior: node('prior', 'mapTask', 'completed', {
            input: [1, 2],
            output: { items: [] },
          }),
          each: node('each', 'mapTask', 'running', { input: items }),
          both: node('both', 'parallel', 'running'),
          hidden: node('hidden', 'mapWorkflow', 'running', { input: ['h'] }),
          ofDone: child('done', '$self', 'completed', {
            kind: 'activity',
            currentAttemptId: last.id,
            attemptCount: 2,
          }),
          ofPrior: child('prior', 'item:0', 'completed', {
            ordinal: 0,
            item: 1,
          }),
          ofEach: items.map((item, ordinal) =>
            child('each', itemKey(ordinal), standing[ordinal] ?? 'completed', {
              ordinal,
              item,
              ...(standing[ordinal] === 'pending' ? {} : { output: ordinal }),
            }),
          ),
          a: child('both', 'member:a', 'completed', {
            kind: 'activity',
            currentAttemptId: aLast.id,
            attemptCount: 2,
          }),
          b: child('both', 'member:b', 'running', {
            kind: 'activity',
            currentAttemptId: bOnly.id,
            attemptCount: 1,
          }),
          ofHidden: child('hidden', 'item:0', 'pending', {
            kind: 'workflow',
            ordinal: 0,
            item: 'h',
          }),
          attempts: { history, last, aFirst, aLast, bOnly },
        }
        return commit(
          {
            nodes: [
              written.done,
              written.prior,
              written.each,
              written.both,
              written.hidden,
            ],
            children: [
              written.ofDone,
              written.ofPrior,
              ...written.ofEach,
              written.a,
              written.b,
              written.ofHidden,
            ],
            attempts: [history, last, aFirst, aLast, bOnly],
          },
          written,
        )
      })
    })

    const without = ({ input: _, ...rest }: StoredNode) => rest
    const byName = <A extends { readonly record: { readonly name: string } }>(
      nodes: readonly A[],
    ) => nodes.toSorted((a, b) => a.record.name.localeCompare(b.record.name))
    const each = (limit: number | 'all') => ({
      nodeName: 'each',
      pendingLimit: limit,
    })

    it.effect(
      'reads every node, and of each under way what it waits on: a map by its window',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const written = yield* opening(store)
          const { run, ofEach, attempts } = written
          const open = yield* view(
            store,
            { open: [{ runId: run.id, maps: [each(2)] }] },
            (snapshot) => ({
              open: snapshot.open.get(run.id),
              runs: snapshot.runs.size,
            }),
          )

          expect(open.runs).toBe(0)
          const { childSets, nodes, ...rest } = open.open!
          expect(rest).toStrictEqual({
            run,
            // The current attempt of each child read, and no other.
            attempts: expect.arrayContaining([attempts.aLast, attempts.bOnly]),
            // No child read started a run.
            linked: new Map(),
          })
          expect(rest.attempts).toHaveLength(2)
          // A map's input is not read, which is not to say it has none.
          expect(byName(nodes)).toStrictEqual([
            { view: 'full', record: written.both },
            { view: 'full', record: written.done },
            { view: 'withoutInput', record: without(written.each) },
            { view: 'withoutInput', record: without(written.hidden) },
            { view: 'withoutInput', record: without(written.prior) },
          ])
          // Nothing of what ended, nor of a map that was not named.
          expect(Array.from(childSets.keys()).toSorted()).toEqual([
            'both',
            'each',
          ])
          expect(childSets.get('both')).toStrictEqual({
            view: 'all',
            children: expect.arrayContaining([written.a, written.b]),
          })
          const set = childSets.get('each')
          expect(set?.view).toBe('map')
          if (set?.view !== 'map') return
          // Waiting ones by ordinal: 2 before 10, though `item:10` sorts first.
          expect(set).toStrictEqual({
            view: 'map',
            active: expect.arrayContaining([ofEach[1], ofEach[4], ofEach[6]]),
            pending: [ofEach[2], ofEach[10]],
            pendingLimit: 2,
            hasMore: true,
          })
          expect(set.active).toHaveLength(3)
        }),
    )

    it.effect(
      'reads a window as far as it is asked, an empty one as empty, and a run loaded whole not at all',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const { run, ofEach } = yield* opening(store)
          const [nothing] = yield* freshIds(store, 1)
          const window = (scope: ReadScope) =>
            view(store, scope, (snapshot) => {
              const set = snapshot.open.get(run.id)?.childSets.get('each')
              return set?.view === 'map'
                ? [set.pending.map(({ childKey }) => childKey), set.hasMore]
                : set
            })
          const open = (...maps: ReturnType<typeof each>[]): ReadScope => ({
            open: [{ runId: run.id, maps }],
          })
          const all = ['item:2', 'item:10', 'item:11']

          expect(yield* window(open(each('all')))).toEqual([all, false])
          expect(yield* window(open(each(3)))).toEqual([all, false])
          expect(yield* window(open(each(1)))).toEqual([['item:2'], true])
          // However large, a limit and the one past it are counted right.
          for (const limit of [2 ** 31 - 1, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
            expect(yield* window(open(each(limit)))).toEqual([all, false])
          }
          // Asked twice, the larger is read.
          expect(
            yield* window({
              open: [
                { runId: run.id, maps: [each(1)] },
                { runId: run.id, maps: [each(2), each(1)] },
              ],
            }),
          ).toEqual([['item:2', 'item:10'], true])
          expect(
            yield* view(
              store,
              { ...open(each(1)), runs: [run.id] },
              (snapshot) => snapshot.open.has(run.id),
            ),
          ).toBe(false)
          expect(
            yield* view(
              store,
              { open: [{ runId: nothing!, maps: [] }] },
              (snapshot) => [
                snapshot.open.has(nothing!),
                snapshot.open.get(nothing!),
              ],
            ),
          ).toEqual([true, undefined])

          // Nothing waits and nothing is under way: read, and empty.
          yield* store.transact({ runs: [run.id] }, () =>
            commit(
              {
                children: ofEach
                  .filter(
                    ({ status }) => !['completed', 'failed'].includes(status),
                  )
                  .map((child) => ({
                    ...child,
                    status: 'completed' as const,
                    version: child.version + 1,
                  })),
              },
              undefined,
            ),
          )
          expect(
            yield* view(store, open(each(2)), (snapshot) =>
              snapshot.open.get(run.id)?.childSets.get('each'),
            ),
          ).toStrictEqual({
            view: 'map',
            active: [],
            pending: [],
            pendingLimit: 2,
            hasMore: false,
          })
        }),
    )

    it.effect(
      'reads the results of a node: its input, and every child by ordinal',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const { run, each: node, ofEach } = yield* opening(store)
          const asked = [
            { runId: run.id, nodeName: 'each' },
            { runId: run.id, nodeName: 'none' },
          ]
          const read = yield* view(store, { childResults: asked }, (snapshot) =>
            asked.map((one) => snapshot.childResults.get(resultsKey(one))),
          )
          expect(read).toStrictEqual([
            { node, children: ofEach },
            { node: undefined, children: [] },
          ])
        }),
    )

    /**
     * A run whose map `each` has an item that ended, one under way and one
     * waiting that a retry left its run, each with a run of its own; and
     * whose parallel `both` has a member that ended and one that waits.
     */
    const linking = Effect.fnUntraced(function* (store: StoreService) {
      const run = yield* create(store)
      const [ended, busy, resumed, member] = yield* Effect.all(
        Array.from({ length: 4 }, () => create(store)),
      )
      yield* store.transact({ runs: [run.id] }, ({ now }) => {
        const record = {
          runId: run.id,
          version: 1,
          createdAt: now,
          updatedAt: now,
        } as const
        const child = (
          nodeName: string,
          childKey: string,
          status: StoredChild['status'],
          childRunId: string,
          ordinal?: number,
        ): StoredChild => ({
          ...record,
          nodeName,
          childKey,
          kind: 'task',
          status,
          attemptCount: 0,
          childRunId,
          ...(ordinal === undefined ? {} : { ordinal, item: ordinal }),
        })
        return commit(
          {
            nodes: [
              {
                ...record,
                name: 'each',
                kind: 'mapTask',
                status: 'running',
                input: [0, 1, 2],
              },
              { ...record, name: 'both', kind: 'parallel', status: 'running' },
            ],
            children: [
              child('each', 'item:0', 'completed', ended!.id, 0),
              child('each', 'item:1', 'running', busy!.id, 1),
              child('each', 'item:2', 'pending', resumed!.id, 2),
              child('both', 'member:a', 'completed', ended!.id),
              child('both', 'member:b', 'waiting', member!.id),
            ],
          },
          undefined,
        )
      })
      const scope: ReadScope = {
        open: [{ runId: run.id, maps: [each(1)] }],
      }
      return { run, busy: busy!, resumed: resumed!, member: member!, scope }
    })

    it.effect('reads the runs of the children read that have not ended', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { run, busy, resumed, member, scope } = yield* linking(store)
        const linked = yield* view(
          store,
          scope,
          (snapshot) => snapshot.open.get(run.id)?.linked,
        )
        expect(linked).toEqual(
          new Map([
            [busy.id, busy],
            [resumed.id, resumed],
            [member.id, member],
          ]),
        )
      }),
    )

    gapped(
      'a writer of the run of a child between an open plan and its commit',
      () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          const { run, busy, scope } = yield* linking(store)
          const bump =
            (read: (snapshot: Snapshot) => StoredRun) =>
            (snapshot: Snapshot) => {
              const seen = read(snapshot)
              return commit(
                { runs: [{ ...seen, version: seen.version + 1 }] },
                undefined,
              )
            }
          const acted = inGap!(
            Effect.orDie(
              store.transact(
                { heads: [busy.id] },
                bump((snapshot) => snapshot.heads.get(busy.id)!),
              ),
            ),
          )
          // Written as it was read with the run that started it: guarded so.
          yield* store.transact(
            scope,
            bump((snapshot) => snapshot.open.get(run.id)!.linked.get(busy.id)!),
          )
          yield* acted
          expect((yield* store.load(busy.id))?.run.version).toBe(
            busy.version + 2,
          )
        }),
    )

    it.effect('writes a node but for its input, which stays as stored', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { run, each: node, done, hidden } = yield* opening(store)
        // One with no input, and one whose input is JSON `null`.
        const bare: StoredNode = { ...without(done), name: 'bare' }
        const blank: StoredNode = { ...done, name: 'blank', input: null }
        yield* store.transact({ runs: [run.id] }, () =>
          commit({ nodes: [bare, blank] }, undefined),
        )

        yield* store.transact(
          { open: [{ runId: run.id, maps: [each(1)] }] },
          () =>
            commit(
              {
                nodesPreservingInput: [
                  {
                    ...without(node),
                    status: 'completed',
                    output: { items: [{ item: null }] },
                    error: { message: 'kept?', cause: { message: 'no' } },
                    version: 2,
                  },
                  // Fields left out are written as left out.
                  { ...without(blank), output: null, version: 2 },
                  { ...without(bare), version: 2 },
                ],
              },
              undefined,
            ),
        )
        const { nodes } = (yield* store.load(run.id))!
        const named = (name: string) => nodes.find((one) => one.name === name)
        expect(named('each')).toStrictEqual({
          ...node,
          status: 'completed',
          output: { items: [{ item: null }] },
          error: { message: 'kept?', cause: { message: 'no' } },
          version: 2,
        })
        expect(named('blank')).toStrictEqual({
          ...without(blank),
          input: null,
          output: null,
          version: 2,
        })
        expect(named('bare')).toStrictEqual({ ...bare, version: 2 })

        const opened = { open: [{ runId: run.id, maps: [] }] }
        const withInput = (input: unknown) => ({
          ...without(hidden),
          input,
          version: 2,
        })
        const refused = yield* Effect.all([
          // Its input is not written, nor unset, by a write that keeps it.
          ...[undefined, ['other']].map((input) =>
            Effect.exit(
              store.transact(opened, () =>
                commit({ nodesPreservingInput: [withInput(input)] }, undefined),
              ),
            ),
          ),
          // A node that is not there is not made by keeping its input.
          Effect.exit(
            store.transact({ runs: [run.id] }, () =>
              commit(
                {
                  nodesPreservingInput: [{ ...without(hidden), name: 'ghost' }],
                },
                undefined,
              ),
            ),
          ),
          // One write of a node: its input is written or kept, not both.
          Effect.exit(
            store.transact({ runs: [run.id] }, () =>
              commit(
                {
                  nodes: [{ ...hidden, version: 3 }],
                  nodesPreservingInput: [{ ...without(hidden), version: 3 }],
                },
                undefined,
              ),
            ),
          ),
        ])
        expect(refused.map(died)).toEqual([true, true, true, true])
        const after = (yield* store.load(run.id))!.nodes
        expect(after.find((one) => one.name === 'hidden')).toStrictEqual(hidden)
        expect(after).toHaveLength(nodes.length)
      }),
    )

    it.effect(
      'writes of an open run what it read, and what it read absent',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const written = yield* opening(store)
          const { run, each: node, ofEach, both, b, done, ofDone } = written
          const { history, bOnly } = written.attempts
          const scope: ReadScope = {
            open: [{ runId: run.id, maps: [each(2)] }],
          }
          const [foreign] = yield* freshIds(store, 1)
          const bumped = <Stored extends { readonly version: number }>(
            record: Stored,
          ) => ({ ...record, version: record.version + 1 })
          const write = (mutation: (snapshot: Snapshot) => Mutation) =>
            Effect.exit(
              store.transact(scope, (snapshot) =>
                commit(mutation(snapshot), undefined),
              ),
            )
          const added = (id: string, childKey = 'member:b'): StoredAttempt => ({
            ...bOnly,
            id,
            childKey,
            attemptNumber: 2,
          })
          const before = sorted(yield* store.load(run.id))

          const refused = yield* Effect.all([
            // Its input was not read: written whole, it would be lost.
            write(() => ({ nodes: [bumped(node)] })),
            // Beyond the window, and of a node that ended.
            write(() => ({ children: [bumped(ofEach[11]!)] })),
            write(() => ({ children: [bumped(ofEach[0]!)] })),
            write(() => ({ children: [bumped(ofDone)] })),
            // Nor is a window enough to add a child: one of its key may wait
            // beyond it.
            write(() => ({
              children: [{ ...ofEach[2]!, childKey: 'item:12', ordinal: 12 }],
            })),
            // Of a map not named, nothing was read.
            write(() => ({ children: [bumped(written.ofHidden)] })),
            // An attempt that is not current, and one of an id not minted.
            write(() => ({ attempts: [{ ...history, status: 'cancelled' }] })),
            write(() => ({ attempts: [added(foreign!)] })),
          ])
          expect(refused.map(died)).toEqual(refused.map(() => true))
          expect(sorted(yield* store.load(run.id))).toEqual(before)

          const accepted = yield* store.transact(scope, (snapshot) => {
            const now = snapshot.now
            const successor = added(snapshot.id('attempt'))
            const fresh: StoredNode = {
              ...done,
              name: 'fresh',
              kind: 'mapWorkflow',
              status: 'running',
              input: ['f'],
            }
            const mutation = {
              nodes: [bumped(both), fresh],
              nodesPreservingInput: [
                { ...bumped(without(node)), status: 'waiting' as const },
              ],
              children: [
                bumped(ofEach[2]!),
                bumped(ofEach[1]!),
                { ...bumped(b), currentAttemptId: successor.id },
                { ...b, childKey: 'member:c', createdAt: now },
                { ...written.ofHidden, nodeName: 'fresh', item: 'f' },
              ],
              attempts: [{ ...bOnly, status: 'failed' as const }, successor],
            }
            return commit(mutation, mutation)
          })
          const stored = sorted(yield* store.load(run.id))!
          expect(
            stored.nodes.find(({ name }) => name === 'each'),
          ).toStrictEqual({
            ...accepted.nodesPreservingInput[0],
            input: node.input,
          })
          expect(
            stored.nodes.find(({ name }) => name === 'fresh'),
          ).toStrictEqual(accepted.nodes[1])
          expect(stored.children).toEqual(
            expect.arrayContaining(accepted.children),
          )
          expect(stored.attempts).toEqual(
            expect.arrayContaining(accepted.attempts),
          )
        }),
    )

    it.effect(
      'writes no child of a node that is absent, but with the node',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const { run, hidden, ofHidden } = yield* opening(store)
          const ghost: StoredChild = { ...ofHidden, nodeName: 'ghost' }
          const opened = { open: [{ runId: run.id, maps: [] }] }
          const write = (scope: ReadScope, mutation: Mutation) =>
            Effect.exit(
              store.transact(scope, () => commit(mutation, undefined)),
            )
          const before = sorted(yield* store.load(run.id))

          // What a run owns is found by its nodes: a child of none would be
          // found by nothing, its family's removal included.
          const refused = yield* Effect.all([
            write(opened, { children: [ghost] }),
            write({ runs: [run.id] }, { children: [ghost] }),
          ])
          expect(refused.map(died)).toEqual([true, true])
          expect(sorted(yield* store.load(run.id))).toEqual(before)

          const node: StoredNode = { ...hidden, name: 'ghost' }
          const made = yield* write(opened, {
            nodes: [node],
            children: [ghost],
          })
          expect(Exit.isSuccess(made)).toBe(true)
          const stored = (yield* store.load(run.id))!
          expect(stored.nodes).toContainEqual(node)
          expect(stored.children).toContainEqual(ghost)
        }),
    )

    it.effect(
      'refuses an ordinal that is no integer, and writes nothing of its mutation',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const { run, ofHidden } = yield* opening(store)
          const before = sorted(yield* store.load(run.id))
          const refused = yield* Effect.forEach(
            [Number.NaN, 0.5, Number.POSITIVE_INFINITY, 2 ** 53],
            (ordinal) =>
              Effect.exit(
                store.transact({ runs: [run.id] }, () =>
                  commit(
                    {
                      // Written before the child, by a store that writes in
                      // order.
                      runs: [{ ...run, version: run.version + 1 }],
                      children: [{ ...ofHidden, childKey: 'item:1', ordinal }],
                    },
                    undefined,
                  ),
                ),
              ),
          )
          expect(refused.map(died)).toEqual([true, true, true, true])
          expect(sorted(yield* store.load(run.id))).toEqual(before)
        }),
    )

    it.effect('reads of the child past a window only that it is there', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        const started = yield* Effect.all([create(store), create(store)])
        // Two items a retry put back in line, each with the run it started
        // and its last attempt.
        const items = yield* store.transact(
          { runs: [run.id] },
          ({ id, now }) => {
            const record = {
              runId: run.id,
              version: 1,
              createdAt: now,
              updatedAt: now,
            } as const
            const items = started.map((childRun, ordinal) => {
              const childKey = itemKey(ordinal)
              const attempt: StoredAttempt = {
                id: id('attempt'),
                runId: run.id,
                nodeName: 'each',
                childKey,
                status: 'failed',
                attemptNumber: 1,
                retryAttemptNumber: 1,
                input: ordinal,
                dispatchedAt: now,
              }
              const child: StoredChild = {
                ...record,
                nodeName: 'each',
                childKey,
                kind: 'task',
                status: 'pending',
                ordinal,
                item: ordinal,
                childRunId: childRun.id,
                currentAttemptId: attempt.id,
                attemptCount: 1,
              }
              return { child, attempt, childRun }
            })
            return commit(
              {
                nodes: [
                  {
                    ...record,
                    name: 'each',
                    kind: 'mapTask',
                    status: 'running',
                    input: [0, 1],
                  },
                ],
                children: items.map(({ child }) => child),
                attempts: items.map(({ attempt }) => attempt),
              },
              items,
            )
          },
        )
        const open = yield* view(
          store,
          { open: [{ runId: run.id, maps: [each(1)] }] },
          (snapshot) => snapshot.open.get(run.id)!,
        )
        const [first] = items
        expect(open.childSets.get('each')).toStrictEqual({
          view: 'map',
          active: [],
          pending: [first!.child],
          pendingLimit: 1,
          hasMore: true,
        })
        expect(open.attempts).toStrictEqual([first!.attempt])
        expect(open.linked).toStrictEqual(
          new Map([[first!.childRun.id, first!.childRun]]),
        )
      }),
    )

    it.effect(
      'reads what lies outside a window by its keys, when a plan asks',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const { run, done, ofDone, ofEach, attempts } = yield* opening(store)
          const plan = planning((draft) => ({
            // Past the window, of what ended, and what is not there.
            past: draft.child(run.id, 'each', 'item:11'),
            ended: draft.child(run.id, 'each', 'item:0'),
            absent: draft.child(run.id, 'each', 'item:99'),
            history: draft.unit({
              runId: run.id,
              nodeName: 'done',
              childKey: '$self',
              attemptId: attempts.history.id,
            }),
          }))
          const whole: number[] = []
          const read = yield* store.transact(
            { open: [{ runId: run.id, maps: [each(1)] }] },
            (snapshot) => {
              whole.push(snapshot.runs.size)
              return plan(snapshot)
            },
          )
          expect(read).toStrictEqual({
            past: ofEach[11],
            ended: ofEach[0],
            absent: undefined,
            history: {
              run,
              node: done,
              child: ofDone,
              attempt: attempts.history,
            },
          })
          // Each asked for, and found, by its keys: never the whole run.
          expect(whole.length).toBeGreaterThan(1)
          expect(new Set(whole)).toEqual(new Set([0]))
        }),
    )

    it.effect(
      'reads as much of a map for a pass, however many items it has',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const width = 4
          const sizes: { records: number; bytes: number }[] = []
          for (const count of [100, 1_000, 5_000]) {
            const run = yield* create(store)
            const started = yield* Effect.all(
              Array.from({ length: width }, () => create(store)),
            )
            // All but the last `3 * width` ended, each with its last attempt;
            // `width` are under way, and twice as many wait.
            yield* store.transact({ runs: [run.id] }, ({ id, now }) => {
              const record = {
                runId: run.id,
                version: 1,
                createdAt: now,
                updatedAt: now,
              } as const
              const items = Array.from({ length: count }, (_, index) => ({
                index,
              }))
              const children: StoredChild[] = []
              const tried: StoredAttempt[] = []
              items.forEach((item, ordinal) => {
                const childKey = itemKey(ordinal)
                const under = ordinal - (count - 3 * width)
                const status =
                  under < 0
                    ? 'completed'
                    : under < width
                      ? 'running'
                      : 'pending'
                const attempt: StoredAttempt | undefined =
                  status === 'pending'
                    ? undefined
                    : {
                        id: id('attempt'),
                        runId: run.id,
                        nodeName: 'each',
                        childKey,
                        status: status === 'running' ? 'started' : 'completed',
                        attemptNumber: 1,
                        retryAttemptNumber: 1,
                        input: item,
                        dispatchedAt: now,
                      }
                if (attempt) tried.push(attempt)
                children.push({
                  ...record,
                  nodeName: 'each',
                  childKey,
                  kind: 'task',
                  status,
                  ordinal,
                  item,
                  attemptCount: attempt ? 1 : 0,
                  ...(attempt ? { currentAttemptId: attempt.id } : {}),
                  ...(status === 'running'
                    ? { childRunId: started[under]!.id }
                    : {}),
                  ...(status === 'completed' ? { output: item } : {}),
                })
              })
              return commit(
                {
                  nodes: [
                    {
                      ...record,
                      name: 'each',
                      kind: 'mapTask',
                      status: 'running',
                      input: items,
                    },
                  ],
                  children,
                  attempts: tried,
                },
                undefined,
              )
            })

            const open = yield* view(
              store,
              { open: [{ runId: run.id, maps: [each(width)] }] },
              (snapshot) => snapshot.open.get(run.id)!,
            )
            const set = open.childSets.get('each')!
            const read = [
              ...open.nodes,
              ...(set.view === 'map' ? [...set.active, ...set.pending] : []),
              ...open.attempts,
              ...open.linked,
            ]
            sizes.push({
              records: read.length,
              bytes: JSON.stringify(read).length,
            })
          }
          // Its node without its items, the children under way and next in
          // line, their attempts and runs: nothing of what ended.
          expect(sizes.map(({ records }) => records)).toEqual([17, 17, 17])
          // Only the digits of ordinals grow, by less than any record more
          // read would weigh.
          for (const { bytes } of sizes) {
            expect(bytes - sizes[0]!.bytes).toBeLessThan(10 * 17)
          }
        }),
    )

    describe('a writer between an open plan and its commit', () => {
      type Opened = Effect.Success<ReturnType<typeof opening>>
      /**
       * Reads the window of `each` and writes, keeping its input, the keys
       * it found waiting there, as a pass decides from what it read.
       */
      const decide = (store: StoreService, runId: string) =>
        store.transact({ open: [{ runId, maps: [each(1)] }] }, (snapshot) => {
          const records = snapshot.open.get(runId)!
          const set = records.childSets.get('each')!
          const read = records.nodes.find(
            ({ record }) => record.name === 'each',
          )!.record
          const waiting = set.view === 'map' ? set.pending : []
          return commit(
            {
              nodesPreservingInput: [
                {
                  ...read,
                  output: waiting.map(({ childKey }) => childKey),
                  version: read.version + 1,
                },
              ],
            },
            undefined,
          )
        })
      const started = (child: StoredChild): StoredChild => ({
        ...child,
        status: 'running',
        version: child.version + 1,
      })
      const races = {
        // A retry: an item before all those waiting waits again.
        'puts a child back in line before those waiting': {
          before: () => [],
          entering: ({ ofEach }: Opened): StoredChild => ({
            ...ofEach[0]!,
            status: 'pending',
            version: 2,
          }),
          read: ['item:2'],
        },
        'adds a child to a window of none': {
          before: ({ ofEach }: Opened) =>
            [2, 10, 11].map((ordinal) => started(ofEach[ordinal]!)),
          entering: ({ ofEach }: Opened): StoredChild => ({
            ...ofEach[2]!,
            childKey: 'item:12',
            ordinal: 12,
          }),
          read: [],
        },
      }
      for (const [name, race] of Object.entries(races)) {
        gapped(name, () =>
          Effect.gen(function* () {
            const { store, inGap } = yield* harness.make()
            const written = yield* opening(store)
            const { run } = written
            const write = (children: readonly StoredChild[]) =>
              store.transact({ runs: [run.id] }, () =>
                commit({ children }, undefined),
              )
            yield* write(race.before(written))
            const entering = race.entering(written)
            const acted = inGap!(Effect.orDie(write([entering])))
            yield* decide(store, run.id)
            const waited = yield* acted

            // A write that came first is what the plan decided on.
            const { nodes } = (yield* store.load(run.id))!
            expect(nodes.find((one) => one.name === 'each')?.output).toEqual(
              waited ? race.read : [entering.childKey],
            )
          }),
        )
      }
    })
  })

  describe('the command queue', () => {
    it.effect('skips a command while an unclaimed one with its key waits', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)

        // Twice in one mutation, and once more in the next.
        yield* enqueue(store, wake(run), wake(run))
        yield* enqueue(store, wake(run))
        const [claim, ...rest] = yield* claims(store)
        expect(rest).toEqual([])

        // A claimed command does not count: a wake that arrives during a
        // pass must outlive it.
        yield* enqueue(store, wake(run))
        yield* enqueue(store, wake(run))
        const [during, ...others] = yield* claims(store)
        expect(others).toEqual([])
        expect(during!.id).not.toBe(claim!.id)

        // Given back, a command waits again and counts again.
        yield* store.release(during!)
        yield* enqueue(store, wake(run))
        expect(yield* claims(store)).toHaveLength(1)
      }),
    )

    it.effect(
      'a command not added leaves the one that waits due no later than itself',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const [far, near, twice, back] = [
            yield* create(store),
            yield* create(store),
            yield* create(store),
            yield* create(store),
          ]
          const at = yield* now(store)

          // Waiting for a time far off, and then wanted at once.
          yield* enqueue(store, wake(far, at + LEASE))
          expect(yield* claims(store)).toEqual([])
          yield* enqueue(store, wake(far))
          const [first, ...rest] = yield* claims(store)
          expect(runIds([first!, ...rest])).toEqual([far.id])
          yield* ack(store, first!)

          // The earlier of the two times, whichever came first: a later one
          // moves nothing, and of two in one mutation the earlier counts.
          yield* enqueue(store, wake(near, at + SHORT))
          yield* enqueue(store, wake(near, at + LEASE))
          yield* enqueue(
            store,
            wake(twice, at + LEASE),
            wake(twice, at + SHORT),
          )
          expect(yield* claims(store)).toEqual([])
          yield* harness.elapse(PAST_SHORT)
          const due = yield* claims(store)
          expect(runIds(due)).toEqual([near.id, twice.id])
          yield* ack(store, ...due)

          // One given back to wait is one that waits.
          yield* enqueue(store, wake(back))
          const [given] = yield* claims(store)
          yield* store.release(given!, { delayMs: LEASE })
          expect(yield* claims(store)).toEqual([])
          yield* enqueue(store, wake(back))
          expect((yield* claims(store)).map(({ id }) => id)).toEqual([
            given!.id,
          ])

          // No command was added on the way: each was the one that waited.
          yield* harness.elapse(PAST_SHORT)
          expect(yield* claims(store)).toEqual([])
        }),
    )

    it.effect('delivers due commands oldest first, up to the limit', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const [first, second, third, later] = [
          yield* create(store),
          yield* create(store),
          yield* create(store),
          yield* create(store),
        ]
        const at = yield* now(store)
        // Queued first, due last: the order is that of queueing.
        yield* enqueue(store, wake(first, at + SHORT))
        yield* enqueue(store, wake(second), wake(third))
        yield* enqueue(store, wake(later, at + LEASE))

        expect(runIds(yield* claims(store, { limit: 1 }))).toEqual([second.id])
        yield* harness.elapse(PAST_SHORT)
        expect(runIds(yield* claims(store, { limit: 5 }))).toEqual([
          first.id,
          third.id,
        ])
        expect(yield* claims(store)).toEqual([])
      }),
    )

    it.effect('routes by kind, name and revision', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const unversioned = yield* create(store)
        const versioned = yield* create(store, { revision: 'r1' })
        const other = yield* create(store, { name: 'contract.other' })
        const task = attempt(unversioned)
        yield* enqueue(store, wake(unversioned), wake(versioned), wake(other), {
          command: task,
          dedupe: 'attempt:1',
        })

        expect(yield* claims(store, { routes: [] })).toEqual([])
        expect(
          yield* claims(store, { routes: [{ name: FLOW, revision: 'r2' }] }),
        ).toEqual([])
        // A route without a revision is the unversioned lane, not a wildcard.
        const lane = yield* claims(store, { routes: [{ name: FLOW }] })
        expect(lane.map(({ command }) => command)).toEqual([
          continueRun(unversioned),
        ])
        const pinned = yield* claims(store, {
          routes: [{ name: 'unknown' }, { name: FLOW, revision: 'r1' }],
        })
        expect(pinned.map(({ command }) => command)).toEqual([
          continueRun(versioned),
        ])
        // A task and a workflow may share a name: the kind keeps them apart.
        const tasks = yield* store.claim({
          lanes: [
            {
              kind: 'runTask',
              routes: [{ name: FLOW }, { name: 'contract.other' }],
            },
          ],
          limit: 10,
          leaseMs: LEASE,
        })
        expect(tasks.map(({ command }) => command)).toEqual([task])
        expect(
          runIds(
            yield* claims(store, { routes: [{ name: 'contract.other' }] }),
          ),
        ).toEqual([other.id])
      }),
    )

    it.effect(
      'commits that queue one key at once leave it due at the earliest time',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const runs = yield* Effect.forEach(
            Array.from({ length: CONCURRENT }),
            () => create(store),
          )
          const at = yield* now(store)

          // Far off and at once, for every run, in whatever order they land.
          yield* Effect.all(
            runs.flatMap((run) => [
              enqueue(store, wake(run, at + LEASE)),
              enqueue(store, wake(run)),
            ]),
            { concurrency: 'unbounded' },
          )
          const due = yield* claims(store, { limit: 2 * CONCURRENT })
          expect(runIds(due).toSorted()).toEqual(
            runs.map(({ id }) => id).toSorted(),
          )
        }),
    )

    it.effect('holds a claim until its lease ends, then delivers again', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        yield* enqueue(store, wake(run))

        const [first] = yield* claims(store, { leaseMs: SHORT })
        expect(first).toMatchObject({ deliveries: 1 })
        expect(yield* claims(store)).toEqual([])

        yield* harness.elapse(PAST_SHORT)
        // The lease ended: the claim is lost before anyone takes the command.
        const lost = new StaleClaim({ commandId: first!.id })
        expect(yield* Effect.flip(ack(store, first!))).toEqual(lost)
        expect(yield* Effect.flip(store.release(first!))).toEqual(lost)
        expect(yield* Effect.flip(store.renew(first!, LEASE))).toEqual(lost)

        const [second] = yield* claims(store)
        expect(second).toMatchObject({ id: first!.id, deliveries: 2 })
        expect(second!.token).not.toBe(first!.token)
        expect(yield* Effect.flip(ack(store, first!))).toEqual(lost)
        yield* ack(store, second!)
      }),
    )

    it.effect('a claim run again, as the effect it is, is another claim', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        yield* enqueue(store, wake(run))

        // One effect, run twice: each run is a delivery of its own.
        const claiming = claims(store, { leaseMs: SHORT })
        const [first] = yield* claiming
        yield* harness.elapse(PAST_SHORT)
        const [second] = yield* claiming
        expect(second).toMatchObject({ id: first!.id, deliveries: 2 })
        expect(second!.token).not.toBe(first!.token)

        // The delivery that lost the command settles nothing for the one
        // that holds it.
        expect(yield* Effect.flip(ack(store, first!))).toEqual(
          new StaleClaim({ commandId: first!.id }),
        )
        yield* store.renew(second!, LEASE)
        yield* ack(store, second!)
      }),
    )

    it.effect(
      'renewing holds a claim longer and answers the run as stored',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const run = yield* create(store)
          yield* enqueue(store, wake(run))
          const [claim] = yield* claims(store, { leaseMs: SHORT })

          expect(yield* store.renew(claim!, LEASE)).toEqual(run)
          const cancelling = {
            ...run,
            status: 'cancelling' as const,
            version: 2,
          }
          yield* store.transact({ heads: [run.id] }, () =>
            commit({ runs: [cancelling] }, undefined),
          )
          yield* harness.elapse(PAST_SHORT)

          // Past the first lease, and still held.
          expect(yield* claims(store)).toEqual([])
          expect(yield* store.renew(claim!, LEASE)).toEqual(cancelling)
          yield* ack(store, claim!)
        }),
    )

    it.effect('gives a released command back at once or after a delay', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        yield* enqueue(store, wake(run))

        const [first] = yield* claims(store)
        yield* store.release(first!)
        expect(yield* Effect.flip(store.release(first!))).toEqual(
          new StaleClaim({ commandId: first!.id }),
        )

        // Given back without an error, the delivery did not count.
        const [second] = yield* claims(store)
        expect(second).toMatchObject({ id: first!.id, deliveries: 1 })
        yield* store.release(second!, {
          error: new Error('not now'),
          delayMs: SHORT,
        })
        expect(yield* claims(store)).toEqual([])
        yield* harness.elapse(PAST_SHORT)
        expect(yield* claims(store)).toMatchObject([
          { id: first!.id, deliveries: 2, command: continueRun(run) },
        ])
      }),
    )

    it.effect(
      'tells when a claimed command was queued, became due and was claimed',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const [later, released, hastened] = [
            yield* create(store),
            yield* create(store),
            yield* create(store),
          ]
          const at = yield* now(store)

          // Due later than it was queued.
          yield* enqueue(store, wake(later, at + SHORT))
          yield* harness.elapse(PAST_SHORT)
          const [first] = yield* claims(store)
          expect(first!.createdAt).toBeGreaterThanOrEqual(at)
          expect(first!.availableAt).toBe(at + SHORT)
          expect(first!.claimedAt).toBeGreaterThanOrEqual(first!.availableAt)
          yield* ack(store, first!)

          // Given back with a delay, it is due again after it; when it was
          // queued stays.
          yield* enqueue(store, wake(released))
          const [claimed] = yield* claims(store)
          expect(claimed!.availableAt).toBe(claimed!.createdAt)
          yield* store.release(claimed!, { delayMs: SHORT })
          yield* harness.elapse(PAST_SHORT)
          const [again] = yield* claims(store)
          expect(again!.createdAt).toBe(claimed!.createdAt)
          expect(again!.availableAt).toBeGreaterThanOrEqual(
            claimed!.claimedAt + SHORT,
          )
          expect(again!.claimedAt).toBeGreaterThanOrEqual(again!.availableAt)
          yield* ack(store, again!)

          // Merged with an earlier wake, it is due at the earlier time,
          // whether it waits or is due already.
          const queued = yield* now(store)
          yield* enqueue(store, wake(hastened, queued + LEASE))
          yield* enqueue(store, wake(hastened, queued + SHORT))
          yield* harness.elapse(PAST_SHORT)
          yield* enqueue(store, wake(hastened, queued - SHORT))
          const [merged] = yield* claims(store)
          expect(merged!.availableAt).toBe(queued - SHORT)
        }),
    )

    it.effect(
      'an acknowledged command is gone, with the rest of its commit',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const run = yield* create(store)
          yield* enqueue(store, wake(run))
          const [claim] = yield* claims(store)

          yield* store.transact({ runs: [run.id] }, () =>
            commit(
              { runs: [{ ...run, version: 2 }], ack: [claim!] },
              undefined,
            ),
          )

          expect((yield* store.load(run.id))?.run.version).toBe(2)
          const gone = new StaleClaim({ commandId: claim!.id })
          expect(yield* Effect.flip(ack(store, claim!))).toEqual(gone)
          expect(yield* Effect.flip(store.renew(claim!, LEASE))).toEqual(gone)
          yield* harness.elapse(PAST_SHORT)
          expect(yield* claims(store)).toEqual([])
        }),
    )

    it.effect(
      'a mutation that names claims to hold applies while they hold, and keeps them',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const run = yield* create(store)
          yield* enqueue(store, wake(run))
          const [claim] = yield* claims(store)
          const write = (version: number, held: Claim) =>
            store.transact({ runs: [run.id], keys: ['k'] }, () =>
              commit(
                {
                  runs: [{ ...run, version }],
                  keys: [{ op: 'acquire', key: 'k', runId: run.id }],
                  enqueue: [{ command: continueRun(run), dedupe: 'another' }],
                  hold: [held],
                },
                undefined,
              ),
            )
          const version = Effect.map(
            store.load(run.id),
            (records) => records?.run.version,
          )

          // Held: applied, and the claim is the worker's as before.
          yield* store.transact({ runs: [run.id] }, () =>
            commit({ runs: [{ ...run, version: 2 }], hold: [claim!] }, 0),
          )
          expect(yield* version).toBe(2)
          expect(yield* store.renew(claim!, LEASE)).toMatchObject({
            version: 2,
          })

          // Given back, it holds no more: nothing of the mutation is applied.
          yield* store.release(claim!)
          const lost = new StaleClaim({ commandId: claim!.id })
          expect(yield* Effect.flip(write(3, claim!))).toEqual(lost)
          expect(yield* version).toBe(2)
          expect(yield* holder(store, 'k')).toBeUndefined()

          // Nor does a claim whose lease has ended. Only the command that
          // was given back is there to claim: no other was queued.
          const [again, ...others] = yield* claims(store, { leaseMs: SHORT })
          expect(others).toEqual([])
          yield* harness.elapse(PAST_SHORT)
          expect(yield* Effect.flip(write(3, again!))).toEqual(lost)
          expect(yield* version).toBe(2)
          expect(yield* holder(store, 'k')).toBeUndefined()
        }),
    )

    it.effect('sets a command aside once it was delivered too often', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make({ maxDeliveries: 2 })
        const poison = yield* create(store)
        const healthy = yield* create(store)
        yield* enqueue(store, wake(poison), wake(healthy))

        // Lost once to an ended lease and once given back: both count.
        const [first] = yield* claims(store, { limit: 1, leaseMs: SHORT })
        yield* harness.elapse(PAST_SHORT)
        const [second] = yield* claims(store, { limit: 1 })
        expect(second).toMatchObject({ id: first!.id, deliveries: 2 })
        yield* store.release(second!, { error: new Error('again') })

        // Dead, it takes no place in a claim and blocks no new command.
        expect(runIds(yield* claims(store, { limit: 1 }))).toEqual([healthy.id])
        expect(yield* claims(store)).toEqual([])
        yield* enqueue(store, wake(poison))
        const [fresh] = yield* claims(store)
        expect(fresh).toMatchObject({ deliveries: 1 })
        expect(fresh!.id).not.toBe(first!.id)
      }),
    )

    it.effect('two claimers never hold one command', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const started = yield* Effect.all(
          Array.from({ length: 30 }, () => create(store)),
        )
        yield* enqueue(store, ...started.map((run) => wake(run)))

        const claimed = yield* Effect.all(
          Array.from({ length: 6 }, () => claims(store, { limit: 10 })),
          { concurrency: 'unbounded' },
        )

        const ids = claimed.flat().map(({ id }) => id)
        expect(new Set(ids).size).toBe(ids.length)
        // What one claimer skipped as taken, the next claim does not miss.
        const rest = yield* claims(store, { limit: 30 })
        expect(ids.length + rest.length).toBe(30)
      }),
    )

    it.effect('claims across lanes in the order commands were queued', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const [first, second] = [yield* create(store), yield* create(store)]
        const task = attempt(first)
        yield* enqueue(
          store,
          wake(first),
          { command: task, dedupe: 'attempt:1' },
          wake(second),
        )

        // The order of the lanes is not that of delivery.
        const both = {
          lanes: [
            { kind: 'runTask', routes: [{ name: FLOW }] },
            { kind: 'continueRun', routes: [{ name: FLOW }] },
          ],
          leaseMs: LEASE,
        } as const
        const taken = yield* store.claim({ ...both, limit: 2 })
        expect(taken.map(({ command }) => command)).toEqual([
          continueRun(first),
          task,
        ])
        expect(runIds(yield* store.claim({ ...both, limit: 2 }))).toEqual([
          second.id,
        ])
      }),
    )

    it.effect('a command given back without an error is never set aside', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make({ maxDeliveries: 1 })
        const run = yield* create(store)
        yield* enqueue(store, wake(run))

        // Workers that stop give their commands back: that is no failure.
        for (let stop = 0; stop < 3; stop++) {
          const [claim] = yield* claims(store)
          expect(claim).toMatchObject({ deliveries: 1 })
          yield* store.release(claim!)
        }
        expect(yield* store.dead({ limit: 10 })).toEqual({ items: [] })
      }),
    )

    it.effect('lists the commands set aside, the earliest first', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make({ maxDeliveries: 1 })
        const [first, second] = [yield* create(store), yield* create(store)]
        const ended = yield* create(store, { status: 'completed' })
        yield* enqueue(store, wake(first), wake(second), wake(ended))

        const [failing, ...lost] = yield* claims(store, { leaseMs: SHORT })
        yield* store.release(failing!, { error: new TypeError('no such step') })
        yield* harness.elapse(PAST_SHORT)
        // Neither is delivered again: each is set aside where it stood.
        expect(yield* claims(store)).toEqual([])

        const all = yield* store.dead({ limit: 10 })
        expect(all.next).toBeUndefined()
        expect(all.items).toEqual([
          {
            id: failing!.id,
            command: continueRun(first),
            deliveries: 1,
            error: expect.objectContaining({
              name: 'TypeError',
              message: 'no such step',
            }),
            createdAt: expect.any(Number),
            deadAt: expect.any(Number),
          },
          // Their leases only ended: nothing said why.
          ...lost.map(({ id, command }) => ({
            id,
            command,
            deliveries: 1,
            createdAt: expect.any(Number),
            deadAt: expect.any(Number),
          })),
        ])
        expect(all.items[0]!.deadAt).toBeGreaterThanOrEqual(first.createdAt)

        // A page at a time.
        const page = yield* store.dead({ limit: 2 })
        expect(page.items).toEqual(all.items.slice(0, 2))
        expect(yield* store.dead({ limit: 2, after: page.next! })).toEqual({
          items: all.items.slice(2),
        })
        expect(yield* store.dead({ limit: 0 })).toEqual({ items: [] })

        // One by its id.
        expect(yield* store.dead({ limit: 10, id: lost[0]!.id })).toEqual({
          items: [all.items[1]],
        })

        // Those of one run, and those of runs that have not ended: the only
        // ones anything is left to do for.
        expect(yield* store.dead({ limit: 10, runId: second.id })).toEqual({
          items: [all.items[1]],
        })
        expect(yield* store.dead({ limit: 10, active: true })).toEqual({
          items: all.items.slice(0, 2),
        })
      }),
    )

    it.effect(
      'a command queued again takes the dead ones of its key away',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make({ maxDeliveries: 1 })
          const run = yield* create(store)
          const dead = Effect.map(store.dead({ limit: 10 }), ({ items }) =>
            items.map(({ id }) => id),
          )
          yield* enqueue(store, wake(run))
          const [first] = yield* claims(store, { leaseMs: SHORT })
          // Queued during the first one's claim, so both exist.
          yield* enqueue(store, wake(run))
          yield* harness.elapse(PAST_SHORT)
          const [second, ...others] = yield* claims(store)
          expect(others).toEqual([])
          expect(second!.id).not.toBe(first!.id)
          expect(yield* dead).toEqual([first!.id])

          // Skipped, because the second waits again: the dead one goes anyway.
          yield* store.release(second!)
          yield* enqueue(store, wake(run))
          expect(yield* dead).toEqual([])
          expect((yield* claims(store)).map(({ id }) => id)).toEqual([
            second!.id,
          ])
        }),
    )

    it.effect('tells which runs have work under a claim that holds', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const [held, lost, released, idle] = [
          yield* create(store),
          yield* create(store),
          yield* create(store),
          yield* create(store),
        ]
        const [missing] = yield* freshIds(store, 1)
        yield* enqueue(store, wake(lost))
        yield* claims(store, { leaseMs: SHORT })
        yield* enqueue(store, wake(held), wake(released), wake(idle))
        const [, given] = yield* claims(store, { limit: 2 })
        yield* store.release(given!)
        yield* harness.elapse(PAST_SHORT)

        const asked = [idle.id, held.id, missing!, lost.id, released.id]
        expect(yield* store.claimed(asked)).toEqual([held.id])
        expect(yield* store.claimed([])).toEqual([])
      }),
    )
  })

  describe('dead commands a plan loads', () => {
    /** A store that sets a command aside at its second claim. */
    const once = harness.make({ maxDeliveries: 1 })
    /** Queues a wake of `run` and has its one delivery lost. */
    const lose = Effect.fnUntraced(function* (
      store: StoreService,
      run: StoredRun,
    ) {
      yield* enqueue(store, wake(run))
      const [claim] = yield* claims(store, { leaseMs: SHORT })
      yield* harness.elapse(PAST_SHORT)
      return claim!
    })
    const listed = (store: StoreService) =>
      Effect.map(store.dead({ limit: 10 }), ({ items }) => items)

    it.effect('are given by id as they are listed, or as absent', () =>
      Effect.gen(function* () {
        const { store } = yield* once
        const [dead, live] = [yield* create(store), yield* create(store)]
        const lost = yield* lose(store, dead)
        expect(yield* claims(store)).toEqual([])
        yield* enqueue(store, wake(live))
        const [held] = yield* claims(store)
        const [missing] = yield* freshIds(store, 1)

        // Asked for by a plan, as anything it needs is.
        let calls = 0
        const seen = yield* store.transact(
          {},
          (snapshot): Planned<Snapshot> =>
            calls++ === 0
              ? {
                  _tag: 'Need',
                  scope: { dead: [lost.id, held!.id, missing!, 'no-command'] },
                }
              : commit({}, snapshot),
        )
        expect(Array.from(seen.dead)).toEqual([
          [lost.id, (yield* listed(store))[0]],
          // A command that is queued or claimed is no dead command.
          [held!.id, undefined],
          [missing, undefined],
          ['no-command', undefined],
        ])
        expect(seen.dead.get(lost.id)).toMatchObject({
          id: lost.id,
          command: continueRun(dead),
          deliveries: 1,
        })
        expect(
          (yield* view(store, { runs: [dead.id] }, (snapshot) => snapshot)).dead
            .size,
        ).toBe(0)
      }),
    )

    gapped('are guarded: one queued again in the gap is seen gone', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* once
        const [run, other] = [yield* create(store), yield* create(store)]
        const lost = yield* lose(store, run)
        expect(yield* claims(store)).toEqual([])

        // A command with its key is queued again: the dead one goes.
        const acted = inGap!(Effect.orDie(enqueue(store, wake(run))))
        const views: boolean[] = []
        // A plan that marks another run for as long as the command is dead.
        yield* store.transact(
          { dead: [lost.id], heads: [other.id] },
          (snapshot) => {
            const dead = snapshot.dead.get(lost.id) !== undefined
            views.push(dead)
            return commit(
              dead ? { runs: [{ ...other, version: 2 }] } : {},
              undefined,
            )
          },
        )
        const waited = yield* acted

        // The writer got in, and the plan ran again on what it left; or it
        // had to wait for the commit, of a plan that was then not undone.
        expect(views).toEqual(waited ? [true] : [true, false])
        expect((yield* store.load(other.id))?.run.version).toBe(waited ? 2 : 1)
        expect(yield* listed(store)).toEqual([])
        expect(yield* claims(store)).toHaveLength(1)
      }),
    )

    gapped('are guarded: one set aside in the gap is seen dead', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* once
        const [run, other] = [yield* create(store), yield* create(store)]
        // Delivered once and lost: the next claim sets it aside.
        const lost = yield* lose(store, run)

        const acted = inGap!(Effect.orDie(claims(store)))
        const views: boolean[] = []
        yield* store.transact(
          { dead: [lost.id], heads: [other.id] },
          (snapshot) => {
            views.push(snapshot.dead.get(lost.id) !== undefined)
            return commit({ runs: [{ ...other, version: 2 }] }, undefined)
          },
        )
        yield* acted

        // What the plan committed on is what was so when it committed: the
        // command was set aside before, and seen, or was not until after.
        const dead = (yield* listed(store)).map(({ id }) => id)
        expect(views.at(-1)).toBe(dead.includes(lost.id))
        expect(views[0]).toBe(false)
        // Nothing keeps it from being set aside once the commit is done.
        expect(yield* claims(store)).toEqual([])
        expect((yield* listed(store)).map(({ id }) => id)).toEqual([lost.id])
      }),
    )
  })

  describe('hints', () => {
    const waiting = Effect.fnUntraced(function* (
      store: StoreService,
      kinds: readonly Command['kind'][],
    ) {
      const hint = yield* store.hints(kinds)
      const next = () => Effect.forkScoped(hint)
      return { next }
    })
    const woke = (fiber: Fiber.Fiber<void>) => fiber.pollUnsafe() !== undefined

    it.effect('tell a subscriber that a command of its kinds became due', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        if (!harness.hints) return
        const run = yield* create(store)
        const { next } = yield* waiting(store, ['runTask', 'continueRun'])

        const first = yield* next()
        yield* settle(harness)
        expect(woke(first)).toBe(false)
        yield* enqueue(store, wake(run))
        yield* Fiber.join(first)

        // One that comes while nobody waits is kept for the next wait.
        const [claim] = yield* claims(store)
        yield* store.release(claim!)
        yield* settle(harness)
        yield* Fiber.join(yield* next())

        // And is taken by that wait: the one after waits again.
        const third = yield* next()
        yield* settle(harness)
        expect(woke(third)).toBe(false)
      }),
    )

    it.effect.skipIf(!harness.hints)(
      'tell of a command that waits and is made due by one not added',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const run = yield* create(store)
          const { next } = yield* waiting(store, ['continueRun'])
          yield* enqueue(store, wake(run, (yield* now(store)) + LEASE))
          const idle = yield* next()
          yield* settle(harness)
          expect(woke(idle)).toBe(false)

          yield* enqueue(store, wake(run))
          yield* Fiber.join(idle)
        }),
    )

    it.effect('are only hints: polling finds what none announced', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        const other = yield* create(store)
        const { next } = yield* waiting(store, ['runTask'])
        const idle = yield* next()

        // Another kind's command, a delayed one and a delayed release.
        yield* enqueue(store, wake(run))
        yield* enqueue(store, wake(other, (yield* now(store)) + SHORT))
        const [claim] = yield* claims(store)
        yield* store.release(claim!, { delayMs: SHORT })
        yield* settle(harness)
        expect(woke(idle)).toBe(false)

        yield* harness.elapse(PAST_SHORT)
        expect(yield* claims(store)).toHaveLength(2)
      }),
    )

    it.effect('a mutation hints the topics it names to their listeners', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        const wait = yield* store.listen('run:1')
        const other = yield* Effect.forkScoped(yield* store.listen('run:2'))
        const notify = (mutation: Mutation) =>
          store.transact({}, () => commit(mutation, undefined))

        const first = yield* Effect.forkScoped(wait)
        // One that is not applied hints nobody.
        yield* enqueue(store, wake(run))
        const [claim] = yield* claims(store)
        yield* store.release(claim!)
        yield* Effect.flip(notify({ notify: ['run:1'], ack: [claim!] }))
        yield* settle(harness)
        expect(woke(first)).toBe(false)

        // Nothing is stored: a topic nobody listens to is no error.
        yield* notify({ notify: ['run:1', 'unheard', 'run:1'] })
        if (!harness.hints) return
        yield* Fiber.join(first)
        yield* settle(harness)
        expect(woke(other)).toBe(false)

        // Kept while nobody waits, and taken by the wait that finds it.
        yield* notify({ notify: ['run:1'] })
        yield* settle(harness)
        yield* Fiber.join(yield* Effect.forkScoped(wait))
        const third = yield* Effect.forkScoped(wait)
        yield* settle(harness)
        expect(woke(third)).toBe(false)
      }),
    )
  })

  describe('lists of runs', () => {
    const ids = (page: {
      readonly items: readonly { readonly id: string }[]
    }) => page.items.map(({ id }) => id)

    /** A parent with two nodes, its child run and one unrelated run. */
    const three = Effect.fnUntraced(function* (store: StoreService) {
      const parent = yield* create(store, {
        tags: { tenant: 'a', plan: 'pro' },
        input: { customer: { id: 7, name: 'Ada' }, items: [1, 2] },
        output: { ok: true },
        presentation: { title: 'Parent' },
      })
      yield* harness.elapse(20)
      const child = yield* store.transact(
        { runs: [parent.id] },
        ({ id, now }) => {
          const node = (name: string, status: StoredNode['status']) =>
            ({
              runId: parent.id,
              name,
              kind: 'task',
              status,
              version: 1,
              createdAt: now,
              updatedAt: now,
            }) satisfies StoredNode
          const child = stored(id('run'), now, {
            kind: 'task',
            status: 'completed',
            revision: 'r1',
            parentRunId: parent.id,
            parentNodeName: 'step',
            // Of an unversioned parent: a route without a revision.
            parentRoute: { name: FLOW },
            rootRunId: parent.id,
          })
          return commit(
            {
              runs: [child],
              nodes: [node('step', 'completed'), node('next', 'pending')],
              children: [
                {
                  runId: parent.id,
                  nodeName: 'step',
                  childKey: '$self',
                  kind: 'task',
                  status: 'completed',
                  childRunId: child.id,
                  attemptCount: 0,
                  version: 1,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            },
            child,
          )
        },
      )
      yield* harness.elapse(20)
      const other = yield* create(store, {
        name: 'contract.other',
        status: 'failed',
        input: [1, 2],
      })
      return { parent, child, other }
    })

    it.effect('are newest first, without payloads, a page at a time', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { parent, child, other } = yield* three(store)

        const all = yield* store.runs({ limit: 10 })
        expect(all.next).toBeUndefined()
        const { input: _, output: __, presentation: ___, ...summary } = parent
        const { input: ____, ...childSummary } = child
        const { input: _____, ...otherSummary } = other
        expect(all.items).toEqual([
          { ...otherSummary, nodesTotal: 0, nodesCompleted: 0 },
          {
            ...childSummary,
            nodesTotal: 0,
            nodesCompleted: 0,
            // The child of its parent that started it.
            origin: { nodeName: 'step', childKey: '$self' },
          },
          { ...summary, nodesTotal: 2, nodesCompleted: 1 },
        ])
        expect(Object.keys(all.items[2]!)).not.toContain('input')

        const page = yield* store.runs({ limit: 2 })
        expect(page.items).toEqual(all.items.slice(0, 2))
        expect(yield* store.runs({ limit: 2, after: page.next! })).toEqual({
          items: all.items.slice(2),
        })
        expect(yield* store.runs({ limit: 0 })).toEqual({ items: [] })

        // A cursor is a place in the order: it holds when a newer run comes,
        // and names the same place in a list that selects fewer.
        yield* create(store)
        expect(yield* store.runs({ limit: 2, after: page.next! })).toEqual({
          items: all.items.slice(2),
        })
        expect(
          yield* store.runs({
            limit: 2,
            after: page.next!,
            filter: { name: FLOW },
          }),
        ).toEqual({ items: all.items.slice(2) })
      }),
    )

    it.effect('runs made at one instant are listed last made first', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const made = yield* store.transact({}, ({ id, now }) => {
          const runs = Array.from({ length: 4 }, () => stored(id('run'), now))
          return commit({ runs }, runs)
        })
        expect(ids(yield* store.runs({ limit: 10 }))).toEqual(
          made.map(({ id }) => id).toReversed(),
        )
      }),
    )

    it.effect('select by what a filter names, all of it at once', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { parent, child, other } = yield* three(store)
        const [missing] = yield* freshIds(store, 1)
        const selected = (filter: RunFilter) =>
          Effect.map(store.runs({ limit: 10, filter }), ids)
        const [p, c, o] = [parent.id, child.id, other.id]

        expect(yield* selected({})).toEqual([o, c, p])
        expect(yield* selected({ kind: 'task' })).toEqual([c])
        expect(yield* selected({ name: 'contract.other' })).toEqual([o])
        expect(yield* selected({ revision: 'r1' })).toEqual([c])
        // `null` asks for what has none; leaving it out asks nothing.
        expect(yield* selected({ revision: null })).toEqual([o, p])
        expect(yield* selected({ parentRunId: null })).toEqual([o, p])
        expect(yield* selected({ parentRunId: p })).toEqual([c])
        expect(yield* selected({ parentRunId: missing! })).toEqual([])
        expect(yield* selected({ rootRunId: p })).toEqual([c, p])
        expect(yield* selected({ status: ['failed', 'completed'] })).toEqual([
          o,
          c,
        ])
        expect(yield* selected({ status: [] })).toEqual([])
        expect(yield* selected({ createdBefore: child.createdAt })).toEqual([p])
        expect(yield* selected({ activeBefore: other.activeSince })).toEqual([
          c,
          p,
        ])

        expect(yield* selected({ tags: { tenant: 'a' } })).toEqual([p])
        expect(yield* selected({ tags: { tenant: 'a', plan: 'pro' } })).toEqual(
          [p],
        )
        expect(
          yield* selected({ tags: { tenant: 'a', plan: 'free' } }),
        ).toEqual([])
        // Containment: a subset of the fields, a subset of the items.
        expect(yield* selected({ input: { customer: { id: 7 } } })).toEqual([p])
        expect(yield* selected({ input: { items: [2] } })).toEqual([p])
        expect(yield* selected({ input: [2, 1] })).toEqual([o])
        expect(yield* selected({ input: { customer: { id: 8 } } })).toEqual([])

        expect(
          yield* selected({
            kind: 'workflow',
            parentRunId: null,
            status: ['running'],
            tags: { plan: 'pro' },
          }),
        ).toEqual([p])
      }),
    )
  })

  describe('schedules', () => {
    const schedule = (
      name: string,
      now: number,
      patch?: Partial<StoredSchedule>,
    ): StoredSchedule => ({
      name,
      runnable: { kind: 'workflow', name: FLOW, revision: 'r1' },
      graphHash: 'hash',
      presentation: { title: 'Nightly' },
      input: { n: null },
      tags: { tenant: 'a' },
      cron: '0 3 * * *',
      timeZone: 'Europe/Paris',
      enabled: true,
      nextRunAt: now + 1_000,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...patch,
    })

    /** Adds schedules, as a plan that loaded which ones exist may. */
    const add = (
      store: StoreService,
      make: (now: number) => readonly StoredSchedule[],
    ) =>
      store.transact({ scheduleNames: true }, (snapshot) => {
        const schedules = make(snapshot.now)
        const names = schedules.map(({ name }) => name)
        return names.every((name) => snapshot.schedules.has(name))
          ? commit({ schedules }, schedules)
          : { _tag: 'Need', scope: { schedules: names } }
      })

    const names = (store: StoreService) =>
      view(store, { scheduleNames: true }, (snapshot) =>
        snapshot.scheduleNames?.toSorted(),
      )

    it.effect('gives back a schedule as written, changed and removed', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const [cron] = yield* add(store, (now) => [schedule('nightly', now)])
        const [every] = yield* add(store, (now) => [
          {
            name: 'often',
            runnable: { kind: 'task', name: 'job' },
            input: [1, 'two'],
            tags: {},
            everyMs: 86_400_000 * 400,
            enabled: false,
            nextRunAt: now,
            lastSlotAt: now - 5,
            version: 3,
            createdAt: now,
            updatedAt: now,
          },
        ])

        const loaded = yield* view(
          store,
          { schedules: ['nightly', 'often', 'none'] },
          (snapshot) => snapshot,
        )
        expect(loaded.schedules).toEqual(
          new Map([
            ['nightly', cron],
            ['often', every],
            ['none', undefined],
          ]),
        )
        // Which ones exist is loaded only when a scope asks for it.
        expect(loaded.scheduleNames).toBeUndefined()
        expect(yield* names(store)).toEqual(['nightly', 'often'])

        // Written whole: a field the next version leaves out is gone.
        const { timeZone: _, ...rest } = cron!
        const next = { ...rest, enabled: false, version: 2 }
        yield* store.transact({ schedules: ['nightly'] }, () =>
          commit({ schedules: [next] }, undefined),
        )
        expect(
          yield* view(store, { schedules: ['nightly'] }, (snapshot) =>
            snapshot.schedules.get('nightly'),
          ),
        ).toEqual(next)

        yield* store.transact(
          { schedules: ['nightly'], scheduleNames: true },
          () => commit({ unschedule: ['nightly'] }, undefined),
        )
        expect(yield* names(store)).toEqual(['often'])
        expect((yield* store.schedules({ limit: 10 })).items).toEqual([every])
      }),
    )

    it.effect(
      'adds and removes one only for a plan that loaded which exist',
      () =>
        Effect.gen(function* () {
          const { store } = yield* harness.make()
          const [kept] = yield* add(store, (now) => [schedule('kept', now)])
          const exits = [
            // Not loaded at all.
            yield* Effect.exit(
              store.transact({}, () =>
                commit({ schedules: [{ ...kept!, version: 2 }] }, undefined),
              ),
            ),
            // Loaded, but not which schedules exist.
            yield* Effect.exit(
              store.transact({ schedules: ['new'] }, ({ now }) =>
                commit({ schedules: [schedule('new', now)] }, undefined),
              ),
            ),
            yield* Effect.exit(
              store.transact({ schedules: ['kept'] }, () =>
                commit({ unschedule: ['kept'] }, undefined),
              ),
            ),
            yield* Effect.exit(
              store.transact({ scheduleNames: true }, () =>
                commit({ unschedule: ['kept'] }, undefined),
              ),
            ),
          ]
          expect(exits.map(died)).toEqual([true, true, true, true])
          expect((yield* store.schedules({ limit: 10 })).items).toEqual([kept])
        }),
    )

    it.effect('concurrent writers of a schedule lose no update', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        yield* add(store, (now) => [schedule('s', now)])
        const bump = store.transact({ schedules: ['s'] }, (snapshot) => {
          const stored = snapshot.schedules.get('s')!
          return commit(
            { schedules: [{ ...stored, version: stored.version + 1 }] },
            undefined,
          )
        })
        yield* Effect.all(
          Array.from({ length: CONCURRENT }, () => bump),
          { concurrency: 'unbounded' },
        )
        expect((yield* store.schedules({ limit: 1 })).items[0]!.version).toBe(
          1 + CONCURRENT,
        )
      }),
    )

    it.effect('concurrent plans see one set of schedules each', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        // Each replaces whatever exists by its own two, as a reconcile does.
        const replace = (own: readonly string[]) =>
          store.transact(
            { scheduleNames: true, schedules: own },
            (snapshot): Planned<undefined> => {
              const stored = snapshot.scheduleNames!
              return stored.every((name) => snapshot.schedules.has(name))
                ? commit(
                    {
                      unschedule: stored.filter((name) => !own.includes(name)),
                      schedules: own.map((name) =>
                        schedule(name, snapshot.now),
                      ),
                    },
                    undefined,
                  )
                : { _tag: 'Need', scope: { schedules: stored } }
            },
          )
        const sets = Array.from({ length: CONCURRENT }, (_, index) => [
          `${index}-a`,
          `${index}-b`,
        ])
        yield* Effect.all(sets.map(replace), { concurrency: 'unbounded' })
        expect(sets).toContainEqual(yield* names(store))
      }),
    )

    describe('a writer between a plan and its commit', () => {
      gapped('of a loaded schedule', () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          yield* add(store, (now) => [schedule('s', now)])
          const bump = (seen: number[]) =>
            store.transact({ schedules: ['s'] }, (snapshot) => {
              const stored = snapshot.schedules.get('s')!
              seen.push(stored.version)
              return commit(
                { schedules: [{ ...stored, version: stored.version + 1 }] },
                undefined,
              )
            })
          const mine: number[] = []
          const theirs: number[] = []
          const acted = inGap!(Effect.orDie(bump(theirs)))
          yield* bump(mine)
          yield* acted

          expect(new Set([mine.at(-1), theirs.at(-1)])).toEqual(new Set([1, 2]))
          expect((yield* store.schedules({ limit: 1 })).items[0]!.version).toBe(
            3,
          )
        }),
      )

      gapped('of which schedules exist', () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          yield* add(store, (now) => [schedule('s', now)])
          // Each replaces whatever exists by its own, as a reconcile does:
          // what is left is the set of one, and nothing of the other.
          const replace = (own: string, seen: (readonly string[])[]) =>
            store.transact(
              { scheduleNames: true, schedules: [own] },
              (snapshot): Planned<undefined> => {
                const stored = snapshot.scheduleNames!
                if (!stored.every((name) => snapshot.schedules.has(name))) {
                  return { _tag: 'Need', scope: { schedules: stored } }
                }
                seen.push(stored)
                return commit(
                  {
                    unschedule: stored.filter((name) => name !== own),
                    schedules: [schedule(own, snapshot.now)],
                  },
                  undefined,
                )
              },
            )
          const mine: (readonly string[])[] = []
          const theirs: (readonly string[])[] = []
          const acted = inGap!(Effect.orDie(replace('theirs', theirs)))
          yield* replace('mine', mine)
          yield* acted

          const left = (yield* names(store))!
          expect(left).toHaveLength(1)
          // The one that is left planned last on the other's.
          const last = left[0] === 'mine' ? mine : theirs
          expect(last.at(-1)).toEqual([left[0] === 'mine' ? 'theirs' : 'mine'])
        }),
      )
    })

    it.effect('lists them by name, a page at a time, and those due', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const at = yield* now(store)
        // By code point: capitals first, and past the BMP after it.
        const ordered = ['B', 'a', 'b', 'é', '\u{ff5e}', '\u{1f600}']
        const [late, off, ...due] = yield* add(store, (now) => [
          schedule('b', now, { nextRunAt: at + 1 }),
          schedule('B', now, { nextRunAt: at - 1, enabled: false }),
          ...['\u{1f600}', 'a', '\u{ff5e}', 'é'].map((name, index) =>
            schedule(name, now, { nextRunAt: at - index }),
          ),
        ])
        const listed = (page: { readonly items: readonly StoredSchedule[] }) =>
          page.items.map(({ name }) => name)

        const all = yield* store.schedules({ limit: 10 })
        expect(listed(all)).toEqual(ordered)
        expect(all.next).toBeUndefined()
        expect(all.items).toEqual(expect.arrayContaining([late, off, ...due]))

        const first = yield* store.schedules({ limit: 4 })
        expect(listed(first)).toEqual(ordered.slice(0, 4))
        expect(
          listed(yield* store.schedules({ limit: 4, after: first.next! })),
        ).toEqual(ordered.slice(4))
        expect(yield* store.schedules({ limit: 0 })).toEqual({ items: [] })

        // Enabled, and at a slot that has come: its very instant included.
        expect(listed(yield* store.schedules({ limit: 10, due: at }))).toEqual(
          ordered.filter((name) => name !== 'B' && name !== 'b'),
        )
        const page = yield* store.schedules({ limit: 3, due: at + 1 })
        expect(listed(page)).toEqual(['a', 'b', 'é'])
        expect(
          listed(
            yield* store.schedules({
              limit: 3,
              due: at + 1,
              after: page.next!,
            }),
          ),
        ).toEqual(['\u{ff5e}', '\u{1f600}'])
      }),
    )
  })

  describe('families', () => {
    const node = (runId: string, now: number): StoredNode => ({
      runId,
      name: 'step',
      kind: 'workflow',
      status: 'completed',
      version: 1,
      createdAt: now,
      updatedAt: now,
    })

    /** A root that ended with a node, and two runs under it. */
    const family = Effect.fnUntraced(function* (
      store: StoreService,
      member?: Partial<StoredRun>,
    ) {
      const root = yield* create(store, { status: 'completed' })
      const [child, grandchild] = yield* store.transact(
        { runs: [root.id] },
        ({ id, now }) => {
          const child = stored(id('run'), now, {
            status: 'failed',
            parentRunId: root.id,
            parentNodeName: 'step',
            rootRunId: root.id,
          })
          const grandchild = stored(id('run'), now, {
            status: 'cancelled',
            parentRunId: child.id,
            parentNodeName: 'step',
            rootRunId: root.id,
            ...member,
          })
          return commit(
            {
              runs: [child, grandchild],
              nodes: [node(root.id, now), node(child.id, now)],
            },
            [child, grandchild] as const,
          )
        },
      )
      return { root, child, grandchild }
    })

    const loaded = (store: StoreService, ...ids: readonly string[]) =>
      view(store, { families: ids }, (snapshot) => snapshot.families)

    const remove = (store: StoreService, rootRunId: string) =>
      store.transact({ families: [rootRunId] }, () =>
        commit({ remove: [rootRunId] }, undefined),
      )

    it.effect('shows a family as its root and what it counts', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const ended = yield* family(store)
        const live = yield* family(store, { status: 'cancelling' })
        const [missing] = yield* freshIds(store, 1)
        // A command under a claim that holds, and one whose claim has ended.
        yield* enqueue(store, wake(ended.root))
        yield* claims(store, { leaseMs: SHORT })
        yield* enqueue(store, wake(live.child))
        yield* claims(store)
        yield* harness.elapse(PAST_SHORT)

        const { input: _, ...summary } = ended.root
        const families = yield* loaded(
          store,
          ended.root.id,
          live.root.id,
          ended.child.id,
          missing!,
          'no-run',
        )
        expect(families.get(ended.root.id)).toEqual({
          root: summary,
          size: 3,
          active: 0,
        })
        expect(families.get(live.root.id)).toMatchObject({
          size: 3,
          active: 1,
          activeRunId: live.grandchild.id,
          claimedRunId: live.child.id,
        })
        // No root: nothing is under it, itself included.
        expect(families.get(ended.child.id)).toMatchObject({
          root: { id: ended.child.id, parentRunId: ended.root.id },
          size: 0,
          active: 0,
        })
        expect(families.get(missing!)).toBeUndefined()
        expect(families.get('no-run')).toBeUndefined()
        expect(families.size).toBe(5)
      }),
    )

    it.effect('removes a family whole, and nothing else', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make({ maxDeliveries: 1 })
        const { root, child, grandchild } = yield* family(store)
        const other = yield* family(store)
        const ids = [root.id, child.id, grandchild.id]
        // All a family leaves behind: keys of its runs, a saved definition,
        // and commands of each kind there is, queued, claimed and dead.
        yield* store.transact(
          { keys: ['a', 'b', 'c'], definitions: ['d'] },
          () =>
            commit(
              {
                keys: [
                  { op: 'acquire', key: 'a', runId: root.id },
                  { op: 'acquire', key: 'b', runId: grandchild.id },
                  { op: 'acquire', key: 'c', runId: other.child.id },
                ],
                definitions: [{ key: 'd', value: { graph: 1 } }],
              },
              undefined,
            ),
        )
        yield* enqueue(store, wake(grandchild))
        yield* claims(store, { leaseMs: SHORT })
        yield* harness.elapse(PAST_SHORT)
        expect(yield* claims(store)).toEqual([])
        yield* enqueue(store, wake(child), wake(other.child))
        const [claimed] = yield* claims(store, { limit: 1 })
        yield* enqueue(store, wake(root), wake(other.root))
        expect(
          (yield* store.dead({ limit: 10 })).items.map(
            ({ command }) => command.runId,
          ),
        ).toEqual([grandchild.id])

        yield* remove(store, root.id)

        for (const id of ids) expect(yield* store.load(id)).toBeUndefined()
        expect(
          (yield* store.runs({ limit: 10, filter: { rootRunId: root.id } }))
            .items,
        ).toEqual([])
        expect(yield* holder(store, 'a')).toBeUndefined()
        expect(yield* holder(store, 'b')).toBeUndefined()
        expect((yield* store.dead({ limit: 10 })).items).toEqual([])
        // The claim went with its command.
        expect(yield* Effect.flip(store.renew(claimed!, LEASE))).toEqual(
          new StaleClaim({ commandId: claimed!.id }),
        )
        expect(yield* Effect.flip(ack(store, claimed!))).toBeInstanceOf(
          StaleClaim,
        )

        // The other family is as it was, with its key and its commands, and
        // the definition is nobody's to take away.
        expect(runIds(yield* claims(store))).toEqual([
          other.child.id,
          other.root.id,
        ])
        expect(yield* holder(store, 'c')).toBe(other.child.id)
        expect(sorted(yield* store.load(other.root.id))).toMatchObject({
          run: other.root,
          nodes: [{ name: 'step' }],
        })
        expect(
          yield* view(store, { definitions: ['d'] }, (snapshot) =>
            snapshot.definitions.get('d'),
          ),
        ).toEqual({ graph: 1 })
        // Removed again, there is nothing to remove.
        yield* remove(store, root.id)
      }),
    )

    it.effect('removes only a family the plan loaded', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { root } = yield* family(store)
        const exits = [
          yield* Effect.exit(
            store.transact({}, () => commit({ remove: [root.id] }, undefined)),
          ),
          // The root as a run is not its family.
          yield* Effect.exit(
            store.transact({ runs: [root.id] }, () =>
              commit({ remove: [root.id] }, undefined),
            ),
          ),
        ]
        expect(exits.map(died)).toEqual([true, true])
        expect((yield* loaded(store, root.id)).get(root.id)?.size).toBe(3)
      }),
    )

    it.effect('writes no run of a family it loaded, its root included', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const { root } = yield* family(store)
        const before = (yield* store.load(root.id))!
        // Guarded by the family, the root's record was not read: written, it
        // would be one the plan creates, and with it all the root owns.
        const next = { ...root, status: 'queued' as const, version: 2 }
        const [step] = before.nodes
        for (const mutation of [
          { runs: [next] },
          { runs: [next], nodes: [{ ...step!, version: 2 }] },
        ]) {
          const exit = yield* Effect.exit(
            store.transact({ families: [root.id] }, () =>
              commit({ ...mutation, enqueue: [wake(root)] }, undefined),
            ),
          )
          expect(died(exit)).toBe(true)
        }

        expect(yield* store.load(root.id)).toEqual(before)
        expect(yield* claims(store)).toEqual([])
      }),
    )

    describe('a writer between a plan and its commit', () => {
      type Runs = {
        readonly root: StoredRun
        readonly child: StoredRun
        readonly grandchild: StoredRun
      }
      /** A plan that removes the family while all of it has ended. */
      const removing = (
        writer: (
          store: StoreService,
          runs: Runs,
        ) => Effect.Effect<unknown, unknown>,
      ) =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          const runs = yield* family(store)
          const { id } = runs.root
          const views: (readonly [number, number, number])[] = []
          const acted = inGap!(Effect.orDie(writer(store, runs)))
          yield* store.transact({ families: [id] }, (snapshot) => {
            const { root, size, active } = snapshot.families.get(id)!
            views.push([root.version, size, active])
            return commit(active === 0 ? { remove: [id] } : {}, undefined)
          })
          yield* acted
          return { views, kept: (yield* store.load(id)) !== undefined }
        })
      const write = (store: StoreService, run: StoredRun) =>
        store.transact({ runs: [run.id] }, () =>
          commit({ runs: [run] }, undefined),
        )

      gapped('of its root', () =>
        Effect.gen(function* () {
          // The writer adds to the root, if the root is there.
          const theirs: (number | undefined)[] = []
          const seen = yield* removing((store, { root }) =>
            store.transact({ runs: [root.id] }, (snapshot) => {
              const found = snapshot.runs.get(root.id)?.run
              theirs.push(found?.version)
              return commit(
                found ? { runs: [{ ...found, version: 2 }] } : {},
                undefined,
              )
            }),
          )

          // The removal was planned on the root as written, or the writer
          // on the root as gone: the family goes, and nothing comes back.
          expect(seen.kept).toBe(false)
          expect([seen.views.at(-1), theirs.at(-1)]).toEqual(
            theirs.at(-1) === undefined
              ? [[1, 3, 0], undefined]
              : [[2, 3, 0], 1],
          )
        }),
      )

      // The runs under a root are not what a family holds: their writers
      // get in, and the removal is planned again on what they left.
      gapped('of a run under it that starts again', () =>
        Effect.gen(function* () {
          const seen = yield* removing((store, { grandchild }) =>
            write(store, { ...grandchild, status: 'queued', version: 2 }),
          )
          expect(seen).toEqual({
            views: [
              [1, 3, 0],
              [1, 3, 1],
            ],
            kept: true,
          })
        }),
      )

      gapped('of which runs are under it', () =>
        Effect.gen(function* () {
          const seen = yield* removing((store, { root, child }) =>
            store.transact({ runs: [child.id] }, ({ id, now }) =>
              commit(
                {
                  runs: [
                    stored(id('run'), now, {
                      parentRunId: child.id,
                      parentNodeName: 'step',
                      rootRunId: root.id,
                    }),
                  ],
                },
                undefined,
              ),
            ),
          )
          expect(seen).toEqual({
            views: [
              [1, 3, 0],
              [1, 4, 1],
            ],
            kept: true,
          })
        }),
      )

      gapped('that removes the family of a run and a key a plan loaded', () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* harness.make()
          const { root, grandchild } = yield* family(store)
          yield* store.transact({ keys: ['held'] }, () =>
            commit(
              { keys: [{ op: 'acquire', key: 'held', runId: grandchild.id }] },
              undefined,
            ),
          )

          const views: unknown[] = []
          const acted = inGap!(Effect.orDie(remove(store, root.id)))
          // A plan on a run under the root and on a key the run holds.
          yield* store.transact(
            { runs: [grandchild.id], keys: ['held', 'next'] },
            (snapshot) => {
              const found = snapshot.runs.get(grandchild.id)?.run
              views.push([found?.version, snapshot.keys.get('held')])
              return commit(
                found
                  ? {
                      runs: [{ ...found, version: found.version + 1 }],
                      keys: [{ op: 'acquire', key: 'next', runId: found.id }],
                    }
                  : {},
                undefined,
              )
            },
          )
          yield* acted

          // The plan ran again on what the removal left, or the removal
          // waited for it: its run and its keys go with the family, and the
          // plan writes nothing of a run that is gone.
          expect([
            [1, grandchild.id],
            [undefined, undefined],
          ]).toContainEqual(views.at(-1))
          expect(yield* store.load(root.id)).toBeUndefined()
          expect(yield* store.load(grandchild.id)).toBeUndefined()
          expect(yield* holder(store, 'held')).toBeUndefined()
          expect(yield* holder(store, 'next')).toBeUndefined()
        }),
      )

      // A run wakes its parent without loading it: the run alone keeps the
      // removal from leaving a command for a parent that is gone.
      gapped(
        'that removes the family of a run whose plan wakes its parent',
        () =>
          Effect.gen(function* () {
            const { store, inGap } = yield* harness.make()
            const { root, child, grandchild } = yield* family(store)

            const views: (number | undefined)[] = []
            const acted = inGap!(Effect.orDie(remove(store, root.id)))
            yield* store.transact({ runs: [grandchild.id] }, (snapshot) => {
              const found = snapshot.runs.get(grandchild.id)?.run
              views.push(found?.version)
              return commit(found ? { enqueue: [wake(child)] } : {}, undefined)
            })
            yield* acted

            // Planned again on the family gone, or the removal waited for the
            // wake and took it with the parent.
            expect([1, undefined]).toContain(views.at(-1))
            expect(yield* store.load(root.id)).toBeUndefined()
            expect(yield* store.load(child.id)).toBeUndefined()
            expect(yield* claims(store)).toEqual([])
          }),
      )
    })
  })

  describe('roots that may be pruned', () => {
    it.effect('are the roots in a status, unchanged for long enough', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const made = (status: StoredRun['status'], parent?: StoredRun) =>
          Effect.tap(
            create(store, {
              status,
              ...(parent
                ? { parentRunId: parent.id, rootRunId: parent.id }
                : {}),
            }),
            () => harness.elapse(20),
          )
        const first = yield* made('completed')
        const failed = yield* made('failed')
        // No root, whatever it ended in.
        yield* made('completed', failed)
        const second = yield* made('completed')
        const third = yield* made('completed')
        const recent = yield* made('completed')
        // Written again, it is the one changed last.
        yield* store.transact({ runs: [first.id] }, ({ now }) =>
          commit(
            { runs: [{ ...first, version: 2, updatedAt: now }] },
            undefined,
          ),
        )
        const scan = (
          query: Partial<Parameters<StoreService['prunable']>[0]> = {},
        ) =>
          store.prunable({
            status: 'completed',
            updatedBefore: recent.updatedAt,
            limit: 10,
            ...query,
          })

        expect(yield* scan()).toEqual({ items: [second.id, third.id] })
        expect(yield* scan({ status: 'failed' })).toEqual({
          items: [failed.id],
        })
        expect(yield* scan({ status: 'cancelled' })).toEqual({ items: [] })
        expect(yield* scan({ updatedBefore: second.updatedAt })).toEqual({
          items: [],
        })

        // The longest unchanged first, a page at a time.
        const all = { updatedBefore: (yield* now(store)) + 1 }
        const page = yield* scan({ ...all, limit: 2 })
        expect(page.items).toEqual([second.id, third.id])
        // A place in the order holds when what it was taken from is gone.
        yield* store.transact({ families: [third.id] }, () =>
          commit({ remove: [third.id] }, undefined),
        )
        expect(yield* scan({ ...all, limit: 2, after: page.next! })).toEqual({
          items: [recent.id, first.id],
        })
        expect(yield* scan({ ...all, limit: 0 })).toEqual({ items: [] })
      }),
    )
  })
}
