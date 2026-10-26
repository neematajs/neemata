import type { Vitest } from '@effect/vitest'
import type * as Scope from 'effect/Scope'
import { describe, expect, it, layer } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Redis from 'effect/persistence/Redis'
import * as TestClock from 'effect/testing/TestClock'

import type {
  AttemptCommand,
  Command,
  RunRecords,
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
} from '../src/store.ts'
import type { StoreHarness, StoreService } from './store-contract.ts'
import { StaleClaim, StorageError } from '../src/errors.ts'
import { coordinate, registry, settle, start, Store } from '../src/index.ts'
import { makeInMemoryStore } from '../src/memory.ts'
import { continueRun } from '../src/model.ts'
import * as RedisStore from '../src/redis/index.ts'
import { COMMIT } from '../src/redis/scripts.ts'
import {
  client,
  connection,
  dump,
  harness,
  keys,
  monitor,
  prefixed,
  SERVERS,
} from './redis-support.ts'

const FLOW = 'redis.flow'
const LEASE = 60_000
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

/** A run under `root`: one of its family. */
const under = (
  store: StoreService,
  root: StoredRun,
  status: StoredRun['status'],
) => create(store, { status, parentRunId: root.id, rootRunId: root.id })

const rewrite = (store: StoreService, run: StoredRun) =>
  store.transact({ heads: [run.id] }, () => commit({ runs: [run] }, run))

const wake = (run: StoredRun): Enqueue => ({
  command: continueRun(run),
  dedupe: `continue:${run.id}`,
})

const enqueue = (store: StoreService, ...entries: readonly Enqueue[]) =>
  store.transact({}, () => commit({ enqueue: entries }, undefined))

const claims = (
  store: StoreService,
  options: { readonly limit?: number; readonly leaseMs?: number } = {},
) =>
  store.claim({
    lanes: [{ kind: 'continueRun', routes: [{ name: FLOW }] }],
    limit: options.limit ?? 10,
    leaseMs: options.leaseMs ?? LEASE,
  })

const view = <A>(
  store: StoreService,
  scope: ReadScope,
  read: (snapshot: Snapshot) => A,
) => store.transact(scope, (snapshot) => commit({}, read(snapshot)))

const holder = (store: StoreService, key: string) =>
  view(store, { keys: [key] }, (snapshot) => snapshot.keys.get(key))

const family = (store: StoreService, id: string) =>
  view(store, { families: [id] }, (snapshot) => snapshot.families.get(id))

const died = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && Cause.hasDies(exit.cause)

const itemsOf = ({ children }: RunRecords) =>
  children.filter(({ nodeName }) => nodeName === 'each')

const ids = (page: { readonly items: readonly { readonly id: string }[] }) =>
  page.items.map(({ id }) => id)

const schedule = (
  name: string,
  now: number,
  patch?: Partial<StoredSchedule>,
): StoredSchedule => ({
  name,
  runnable: { kind: 'workflow', name: FLOW },
  input: { n: 1 },
  tags: {},
  everyMs: 60_000,
  enabled: true,
  nextRunAt: now + 60_000,
  version: 1,
  createdAt: now,
  updatedAt: now,
  ...patch,
})

/**
 * What a list shows of records that were written more than once, and so what
 * the indexes behind it must follow. Asserted through the service alone and
 * run against the reference store too: it states the reference's behaviour,
 * not this adapter's.
 */
function rewritten<R>(
  it: { readonly effect: Vitest.Tester<R | Scope.Scope> },
  harness: StoreHarness<R>,
) {
  describe('what lists read', () => {
    it.effect('list a run by what it is now, however often it changed', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const root = yield* create(store)
        const made = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, index) => index),
          (index) =>
            create(store, {
              kind: index % 2 === 0 ? 'workflow' : 'task',
              name: `flow-${index % 3}`,
              tags: { tenant: `t${index % 2}`, plan: 'free' },
            }),
        )
        // Every field a list selects by changes, some of them twice.
        const statuses = ['completed', 'waiting', 'failed'] as const
        const changed: StoredRun[] = []
        for (const [index, run] of made.entries()) {
          let next: StoredRun = run
          for (let round = 0; round <= index % 3; round++) {
            const { revision: _, parentRunId: __, ...rest } = next
            next = yield* rewrite(store, {
              ...rest,
              status: statuses[(index + round) % 3]!,
              name: `flow-${(index + round) % 4}`,
              tags:
                (index + round) % 2 === 0
                  ? { tenant: 'moved' }
                  : { plan: 'pro', tenant: `t${index % 2}` },
              ...((index + round) % 3 === 0 ? {} : { revision: `r${round}` }),
              ...((index + round) % 2 === 0
                ? { rootRunId: run.id }
                : { parentRunId: root.id, rootRunId: root.id }),
              version: next.version + 1,
            })
          }
          changed.push(next)
        }

        const all = [...changed.toReversed(), root]
        const filters: RunFilter[] = [
          {},
          { kind: 'task' },
          { name: 'flow-1' },
          { name: 'flow-3' },
          { revision: null },
          { revision: 'r0' },
          { revision: 'r2' },
          { status: ['waiting'] },
          { status: ['completed', 'failed'] },
          { status: ['running'] },
          { parentRunId: null },
          { parentRunId: root.id },
          { rootRunId: root.id },
          { tags: { tenant: 'moved' } },
          { tags: { plan: 'pro', tenant: 't1' } },
          { tags: { plan: 'free' } },
          { kind: 'workflow', status: ['failed', 'waiting'], revision: null },
        ]
        const selects = (run: StoredRun, filter: RunFilter) =>
          (filter.kind === undefined || run.kind === filter.kind) &&
          (filter.name === undefined || run.name === filter.name) &&
          (filter.revision === undefined ||
            (run.revision ?? null) === filter.revision) &&
          (filter.status === undefined || filter.status.includes(run.status)) &&
          (filter.parentRunId === undefined ||
            (run.parentRunId ?? null) === filter.parentRunId) &&
          (filter.rootRunId === undefined ||
            run.rootRunId === filter.rootRunId) &&
          Object.entries(filter.tags ?? {}).every(
            ([key, value]) => run.tags[key] === value,
          )
        for (const filter of filters) {
          const expected = all
            .filter((run) => selects(run, filter))
            .map(({ id }) => id)
          // A page at a time, so that every index is walked from a cursor.
          const listed: string[] = []
          let after: string | undefined
          do {
            const page = yield* store.runs({
              filter,
              limit: 3,
              ...(after === undefined ? {} : { after }),
            })
            listed.push(...ids(page))
            after = page.next
          } while (after !== undefined)
          expect(listed, JSON.stringify(filter)).toEqual(expected)
        }
        expect(yield* family(store, root.id)).toMatchObject({
          size: all.filter((run) => run.rootRunId === root.id).length,
          active: all.filter(
            (run) =>
              run.rootRunId === root.id &&
              (run.status === 'waiting' || run.status === 'running'),
          ).length,
        })
      }),
    )

    it.effect('count the nodes of a run as they are written', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const run = yield* create(store)
        const node = (name: string, status: StoredNode['status']) =>
          store.transact({ runs: [run.id] }, ({ now }) =>
            commit(
              {
                nodes: [
                  {
                    runId: run.id,
                    name,
                    kind: 'activity',
                    status,
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              },
              undefined,
            ),
          )
        const counts = Effect.map(store.runs({ limit: 1 }), ({ items }) => [
          items[0]!.nodesTotal,
          items[0]!.nodesCompleted,
        ])

        expect(yield* counts).toEqual([0, 0])
        yield* node('a', 'pending')
        yield* node('b', 'completed')
        expect(yield* counts).toEqual([2, 1])
        yield* node('a', 'completed')
        yield* node('a', 'completed')
        expect(yield* counts).toEqual([2, 2])
        // A retry takes a node back.
        yield* node('b', 'pending')
        yield* node('b', 'running')
        expect(yield* counts).toEqual([2, 1])
      }),
    )

    it.effect('tell a run of the child that started it, while it does', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const parent = yield* create(store)
        const [first, second] = [yield* create(store), yield* create(store)]
        const starts = (childKey: string, childRunId?: string) =>
          store.transact({ runs: [parent.id] }, ({ now }) =>
            commit(
              {
                nodes: [
                  {
                    runId: parent.id,
                    name: 'step',
                    kind: 'mapWorkflow',
                    status: 'running',
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
                children: [
                  {
                    runId: parent.id,
                    nodeName: 'step',
                    childKey,
                    kind: 'workflow',
                    status: 'waiting',
                    ...(childRunId === undefined ? {} : { childRunId }),
                    attemptCount: 0,
                    version: 1,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              },
              undefined,
            ),
          )
        const origins = Effect.map(store.runs({ limit: 10 }), ({ items }) =>
          Object.fromEntries(
            items.flatMap(({ id, origin }) =>
              origin ? [[id, origin.childKey]] : [],
            ),
          ),
        )

        yield* starts('item:0', first.id)
        yield* starts('item:1', second.id)
        expect(yield* origins).toEqual({
          [first.id]: 'item:0',
          [second.id]: 'item:1',
        })
        // A child that starts no run any more, and one that starts another.
        yield* starts('item:0')
        expect(yield* origins).toEqual({ [second.id]: 'item:1' })
        yield* starts('item:1', first.id)
        expect(yield* origins).toEqual({ [first.id]: 'item:1' })
        yield* starts('item:1')
        expect(yield* origins).toEqual({})
      }),
    )

    it.effect('list a dead command as active while its run has not ended', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make({ maxDeliveries: 1 })
        const run = yield* create(store)
        // A command of a run that does not exist yet.
        const [later] = yield* store.transact({}, ({ id }) =>
          commit({}, [id('run')]),
        )
        yield* enqueue(store, wake(run), wake(stored(later!, 0)))
        for (const claim of yield* claims(store)) {
          yield* store.release(claim, { error: new Error('no') })
        }
        expect(yield* claims(store)).toEqual([])
        const active = Effect.map(
          store.dead({ limit: 10, active: true }),
          ({ items }) => items.map(({ command }) => command.runId),
        )

        expect(yield* active).toEqual([run.id])
        yield* rewrite(store, { ...run, status: 'failed' })
        expect(yield* active).toEqual([])
        yield* store.transact({}, ({ now }) =>
          commit({ runs: [stored(later!, now)] }, undefined),
        )
        yield* rewrite(store, { ...run, status: 'running' })
        expect(yield* active).toEqual([run.id, later])
        expect(yield* store.dead({ limit: 10, runId: later! })).toMatchObject({
          items: [{ command: { runId: later } }],
        })
      }),
    )
  })

  describe('the roots that may be pruned', () => {
    it.effect('are those of a status, the longest unchanged first', () =>
      Effect.gen(function* () {
        const { store } = yield* harness.make()
        const [a, b, c, failed, late, child] = yield* store.transact(
          {},
          ({ id, now }) => {
            const root = (updatedAt: number, patch?: Partial<StoredRun>) =>
              stored(id('run'), now, {
                status: 'completed',
                updatedAt,
                ...patch,
              })
            const a = root(now - 1_000)
            const runs = [
              a,
              // Unchanged for as long as the first: the earlier created first.
              root(now - 1_000),
              root(now - 2_000),
              root(now - 3_000, { status: 'failed' }),
              root(now),
              root(now - 5_000, { parentRunId: a.id, rootRunId: a.id }),
            ]
            return commit({ runs }, runs)
          },
        )
        const now = late!.updatedAt
        const prunable = (query: {
          status?: StoredRun['status']
          updatedBefore?: number
          limit?: number
          after?: string
        }) =>
          store.prunable({
            status: 'completed',
            updatedBefore: now,
            limit: 10,
            ...query,
          })

        // Roots alone, and strictly earlier.
        expect(yield* prunable({})).toEqual({ items: [c!.id, a!.id, b!.id] })
        expect((yield* prunable({ updatedBefore: now + 1 })).items).toEqual([
          c!.id,
          a!.id,
          b!.id,
          late!.id,
        ])
        expect(yield* prunable({ updatedBefore: now - 1_000 })).toEqual({
          items: [c!.id],
        })
        expect(yield* prunable({ status: 'failed' })).toEqual({
          items: [failed!.id],
        })
        expect(yield* prunable({ status: 'running' })).toEqual({ items: [] })
        expect(yield* prunable({ limit: 0 })).toEqual({ items: [] })
        expect(child!.parentRunId).toBe(a!.id)

        // A cursor is a place: it holds when its root has gone.
        const page = yield* prunable({ limit: 2 })
        expect(page.items).toEqual([c!.id, a!.id])
        yield* store.transact({ families: [a!.id] }, () =>
          commit({ remove: [a!.id] }, undefined),
        )
        expect(yield* prunable({ limit: 2, after: page.next! })).toEqual({
          items: [b!.id],
        })

        // A root that changes is listed by what it is now.
        yield* rewrite(store, { ...c!, updatedAt: now - 500 })
        yield* rewrite(store, { ...b!, status: 'failed' })
        expect(yield* prunable({})).toEqual({ items: [c!.id] })
        expect(yield* prunable({ status: 'failed' })).toEqual({
          items: [failed!.id, b!.id],
        })
      }),
    )
  })
}

describe('the reference store', () => {
  rewritten(it, {
    make: (options) =>
      Effect.sync(() => {
        let act: Effect.Effect<unknown> | undefined
        const { store } = makeInMemoryStore({
          ...options,
          beforeCommit: () => {
            const pending = act
            act = undefined
            if (pending) Effect.runSync(pending)
          },
        })
        return {
          store,
          inGap: (pending) => {
            act = pending
            return Effect.succeed(false)
          },
        }
      }),
    elapse: (ms) => TestClock.adjust(ms),
    hints: true,
    gap: true,
  })
})

const options = { excludeTestServices: true, timeout: '60 seconds' } as const

/** What only this adapter has: its keyspace, its scripts and its server. */
function adapter(url: string) {
  return (it: {
    readonly effect: Vitest.Tester<Redis.Redis | Scope.Scope>
  }) => {
    /** A store, its prefix, and a second store on a connection of its own. */
    const two = Effect.fnUntraced(function* (
      options: (
        other: StoreService,
        prefix: string,
      ) => RedisStore.RedisOptions = () => ({}),
    ) {
      const prefix = yield* prefixed
      const other = yield* RedisStore.make({ prefix }).pipe(
        Effect.provideService(Redis.Redis, yield* connection(url)),
      )
      const store = yield* RedisStore.make({
        prefix,
        ...options(other, prefix),
      })
      return { prefix, store, other }
    })

    /** Something of every kind the store keeps. */
    const busy = Effect.fnUntraced(function* (store: StoreService) {
      const run = yield* create(store, { tags: { tenant: 'a' } })
      const waiting = yield* create(store)
      yield* store.transact(
        {
          runs: [run.id],
          keys: ['k'],
          definitions: ['d'],
          schedules: ['s'],
          scheduleNames: true,
        },
        ({ now }) =>
          commit(
            {
              nodes: [
                {
                  runId: run.id,
                  name: 'step',
                  kind: 'activity',
                  status: 'completed',
                  version: 1,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
              keys: [{ op: 'acquire', key: 'k', runId: run.id }],
              definitions: [{ key: 'd', value: 1 }],
              schedules: [schedule('s', now)],
              enqueue: [wake(run)],
            },
            undefined,
          ),
      )
      const [claim] = yield* claims(store)
      yield* enqueue(store, wake(waiting))
      return { run, waiting, claim: claim! }
    })

    /** A mutation that writes everything a mutation can. */
    const everything = (
      { now, id }: Snapshot,
      run: StoredRun,
      patch: Mutation,
    ): Mutation => ({
      runs: [
        { ...run, status: 'completed', version: 9 },
        stored(id('run'), now),
      ],
      nodes: [
        {
          runId: run.id,
          name: 'next',
          kind: 'activity',
          status: 'pending',
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      children: [
        {
          runId: run.id,
          nodeName: 'next',
          childKey: '$self',
          kind: 'task',
          status: 'pending',
          childRunId: id('run'),
          attemptCount: 0,
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      attempts: [
        {
          id: id('attempt'),
          runId: run.id,
          nodeName: 'next',
          childKey: '$self',
          status: 'started',
          attemptNumber: 1,
          retryAttemptNumber: 1,
          input: 1,
          dispatchedAt: now,
        },
      ],
      keys: [
        { op: 'release', key: 'k', runId: run.id },
        { op: 'acquire', key: 'k2', runId: run.id },
      ],
      definitions: [{ key: 'd2', value: 2 }],
      schedules: [schedule('s', now, { version: 2 }), schedule('s2', now)],
      unschedule: ['s'],
      enqueue: [{ command: continueRun(run), dedupe: 'another' }],
      notify: ['topic'],
      ...patch,
    })
    const scope = (run: StoredRun): ReadScope => ({
      runs: [run.id],
      keys: ['k', 'k2'],
      definitions: ['d', 'd2'],
      schedules: ['s', 's2'],
      scheduleNames: true,
    })

    describe('a commit that fails a check', () => {
      it.effect('writes nothing when a claim it acknowledges is stale', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const { run, claim } = yield* busy(store)
          yield* store.release(claim)
          const before = yield* dump(prefix)

          const error = yield* Effect.flip(
            store.transact(scope(run), (snapshot) =>
              commit(everything(snapshot, run, { ack: [claim] }), undefined),
            ),
          )
          expect(error).toEqual(new StaleClaim({ commandId: claim.id }))
          expect(yield* dump(prefix)).toEqual(before)
        }),
      )

      it.effect('writes nothing when what it read has changed', () =>
        Effect.gen(function* () {
          let between: Record<string, unknown> | undefined
          const redis = yield* Redis.Redis
          const { prefix, store, other } = yield* two((other, prefix) => ({
            maxAttempts: 1,
            // Another connection gets in first.
            beforeCommit: () =>
              Effect.gen(function* () {
                yield* other.transact({ keys: ['k2'] }, () =>
                  commit(
                    { keys: [{ op: 'acquire', key: 'k2', runId: 'x' }] },
                    undefined,
                  ),
                )
                between = yield* dump(prefix)
              }).pipe(Effect.provideService(Redis.Redis, redis), Effect.orDie),
          }))
          const { run, claim } = yield* busy(other)

          const error = yield* Effect.flip(
            store.transact(scope(run), (snapshot) =>
              commit(everything(snapshot, run, { ack: [claim] }), undefined),
            ),
          )
          expect(error).toBeInstanceOf(StorageError)
          expect(between).toBeDefined()
          expect(yield* dump(prefix)).toEqual(between)
        }),
      )

      it.effect('writes nothing of a plan that is broken', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const { run, waiting, claim } = yield* busy(store)
          const before = yield* dump(prefix)
          const [missing] = yield* store.transact({}, ({ id }) =>
            commit({}, [id('run')]),
          )
          const broken = (scope: ReadScope, patch: Mutation) =>
            Effect.exit(
              store.transact(scope, (snapshot) =>
                commit(
                  everything(snapshot, run, { ack: [claim], ...patch }),
                  undefined,
                ),
              ),
            )

          // A run that is there, written without having been loaded.
          const over = yield* broken(scope(run), {
            runs: [{ ...waiting, version: 9 }],
          })
          // A definition that is saved, written over.
          const saved = yield* broken(scope(run), {
            definitions: [{ key: 'd', value: 'other' }],
          })
          // A node of a run that does not exist.
          const orphan = yield* broken(
            { ...scope(run), heads: [missing!] },
            {
              nodes: [
                {
                  runId: missing!,
                  name: 'step',
                  kind: 'activity',
                  status: 'pending',
                  version: 1,
                  createdAt: 0,
                  updatedAt: 0,
                },
              ],
            },
          )

          expect([over, saved, orphan].map(died)).toEqual([true, true, true])
          expect(yield* dump(prefix)).toEqual(before)
          // The claim still holds: nothing of those commits was applied.
          yield* store.renew(claim, LEASE)
        }),
      )

      it.effect('refuses records of a run the plan did not load', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const run = yield* create(store)
          const before = yield* dump(prefix)
          const exit = yield* Effect.exit(
            store.transact({}, ({ now }) =>
              commit(
                {
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
                },
                undefined,
              ),
            ),
          )

          expect(String(Exit.isFailure(exit) && Cause.squash(exit.cause))).toBe(
            `Error: Unguarded write to [run:${run.id}]`,
          )
          expect(yield* dump(prefix)).toEqual(before)
        }),
      )

      it.effect('a commit that passes them all writes all of it', () =>
        Effect.gen(function* () {
          const { store } = yield* two()
          const { run, claim } = yield* busy(store)
          const made = yield* store.transact(scope(run), (snapshot) => {
            const mutation = everything(snapshot, run, { ack: [claim] })
            return commit(mutation, mutation)
          })

          const records = yield* store.load(run.id)
          expect(records?.run).toEqual(made.runs![0])
          expect(records?.nodes.map(({ name }) => name).toSorted()).toEqual([
            'next',
            'step',
          ])
          expect(records?.children).toEqual(made.children)
          expect(records?.attempts).toEqual(made.attempts)
          expect(yield* store.load(made.runs![1]!.id)).toBeDefined()
          expect(yield* holder(store, 'k')).toBeUndefined()
          expect(yield* holder(store, 'k2')).toBe(run.id)
          expect(
            (yield* store.schedules({ limit: 10 })).items.map(
              ({ name }) => name,
            ),
          ).toEqual(['s2'])
          expect(yield* Effect.flip(store.renew(claim, LEASE))).toEqual(
            new StaleClaim({ commandId: claim.id }),
          )
          expect(yield* claims(store)).toHaveLength(2)
        }),
      )
    })

    // A failover promotes a server with the state it had at an earlier
    // moment: what was committed since is lost, and every counter it keeps
    // is set back with the rest.
    describe('a server set back to an earlier state', () => {
      /** Keeps the store as it is now, and gives what puts it back so. */
      const kept = Effect.fnUntraced(function* (prefix: string) {
        const redis = yield* Redis.Redis
        const root = `{${prefix}}`
        // Copies beside the store, in its slot, where it never looks.
        const copy = (key: string) => `${root}kept:${key.slice(root.length)}`
        const saved = yield* keys(prefix)
        for (const key of saved) yield* redis.send('COPY', key, copy(key))
        return Effect.gen(function* () {
          const live = (yield* keys(prefix)).filter(
            (key) => !key.startsWith(copy(root)),
          )
          yield* redis.send('UNLINK', ...live)
          for (const key of saved) yield* redis.send('COPY', copy(key), key)
        }).pipe(Effect.provideService(Redis.Redis, redis), Effect.orDie)
      }, Effect.orDie)

      it.effect('gives no revision a reader of before still holds', () =>
        Effect.gen(function* () {
          let between: Effect.Effect<unknown> = Effect.void
          const { prefix, store, other } = yield* two(() => ({
            beforeCommit: () => {
              const once = between
              between = Effect.void
              return once
            },
          }))
          const write = (
            store: StoreService,
            runId: string,
            next: (version: number) => number,
          ) =>
            store.transact({ runs: [runId] }, (snapshot) => {
              const { run } = snapshot.runs.get(runId)!
              return commit(
                { runs: [{ ...run, version: next(run.version) }] },
                run.version,
              )
            })
          const run = yield* create(store)
          const back = yield* kept(prefix)
          // A commit the failover loses, which the reader has read.
          yield* write(other, run.id, () => 2)
          // The failover comes between the reader's plan and its commit,
          // and the first writer after it is another.
          between = Effect.andThen(
            back,
            Effect.orDie(write(other, run.id, () => 9)),
          )
          const seen: number[] = []
          yield* write(store, run.id, (version) => {
            seen.push(version)
            return version + 1
          })

          // The reader's plan was void, and ran again on what is stored.
          expect(seen).toEqual([2, 9])
          expect((yield* store.load(run.id))?.run.version).toBe(10)
        }),
      )

      it.effect('gives no claim a claimant of before still holds', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const run = yield* create(store)
          yield* enqueue(store, wake(run))
          const back = yield* kept(prefix)
          // A claim the failover loses, which its worker still acts on.
          const [lost] = yield* claims(store)
          yield* back
          const [held] = yield* claims(store)
          expect(held!.id).toBe(lost!.id)

          const stale = new StaleClaim({ commandId: lost!.id })
          expect(yield* Effect.flip(store.renew(lost!, LEASE))).toEqual(stale)
          expect(yield* Effect.flip(store.release(lost!))).toEqual(stale)
          expect(
            yield* Effect.flip(
              store.transact({}, () => commit({ ack: [lost!] }, undefined)),
            ),
          ).toEqual(stale)
          // The command is the new claimant's, to the end.
          expect(yield* store.renew(held!, LEASE)).toEqual(run)
          yield* store.transact({}, () => commit({ ack: [held!] }, undefined))
        }),
      )
    })

    describe('planning again', () => {
      const bump = (store: StoreService, runId: string, calls: { n: number }) =>
        store.transact({ runs: [runId] }, (snapshot) => {
          calls.n += 1
          const { run } = snapshot.runs.get(runId)!
          return commit({ runs: [{ ...run, version: run.version + 1 }] }, 0)
        })

      it.effect('writers on two connections lose no update', () =>
        Effect.gen(function* () {
          const { store, other } = yield* two()
          const run = yield* create(store)
          const calls = { n: 0 }
          yield* Effect.all(
            Array.from({ length: 40 }, (_, index) =>
              bump(index % 2 === 0 ? store : other, run.id, calls),
            ),
            { concurrency: 'unbounded' },
          )
          expect((yield* store.load(run.id))?.run.version).toBe(41)
          // They did race: some planned on a view another had changed.
          expect(calls.n).toBeGreaterThan(40)
        }),
      )

      it.effect('gives up after the attempts it is allowed', () =>
        Effect.gen(function* () {
          const calls = { n: 0 }
          const ignored = { n: 0 }
          let interfere = Effect.void
          const { store, other } = yield* two(() => ({
            maxAttempts: 3,
            beforeCommit: () => interfere,
          }))
          const run = yield* create(store)
          interfere = Effect.orDie(bump(other, run.id, ignored))

          const error = yield* Effect.flip(bump(store, run.id, calls))
          expect(error).toBeInstanceOf(StorageError)
          expect(calls.n).toBe(3)
          // Only the other writer's three updates are stored.
          expect((yield* store.load(run.id))?.run.version).toBe(4)
        }),
      )
    })

    describe('indexes', () => {
      it.effect('are read instead of the runs they list', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const run = yield* create(store, { tags: { tenant: 'a' } })
          const index = (name: string) =>
            Effect.map(dump(prefix), (contents) => contents[`runs:${name}`])
          const place = [expect.stringMatching(`^\\d{31}:${run.id}$`), '0']

          expect(yield* index('status:running')).toEqual(place)
          expect(yield* index(`active:${run.id}`)).toEqual(place)
          expect(yield* index('tag:["tenant","a"]')).toEqual(place)
          const [member] = (yield* index('all')) as string[]

          yield* rewrite(store, { ...run, status: 'completed', tags: {} })
          expect(yield* index('status:running')).toBeUndefined()
          expect(yield* index(`active:${run.id}`)).toBeUndefined()
          expect(yield* index('tag:["tenant","a"]')).toBeUndefined()
          // Its place is its own for good: it is the cursor of every list.
          expect(yield* index('status:completed')).toEqual([member, '0'])
          expect(yield* index('all')).toEqual([member, '0'])
        }),
      )

      it.effect('leave nothing behind when all they listed is gone', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two(() => ({ maxDeliveries: 1 }))
          const root = yield* create(store, { tags: { tenant: 'a' } })
          const child = yield* under(store, root, 'running')
          const second = yield* under(store, root, 'completed')
          yield* store.transact(
            {
              runs: [root.id],
              keys: ['k', 'k2'],
              schedules: ['s'],
              scheduleNames: true,
            },
            (snapshot) =>
              commit(
                {
                  ...everything(snapshot, root, {
                    runs: [],
                    definitions: [],
                    unschedule: [],
                    schedules: [schedule('s', snapshot.now)],
                    children: [],
                  }),
                  keys: [
                    { op: 'acquire', key: 'k', runId: root.id },
                    { op: 'acquire', key: 'k2', runId: child.id },
                  ],
                  enqueue: [wake(root), wake(child), wake(second)],
                },
                undefined,
              ),
          )
          // One command dead, one given back for later, one claimed, and
          // one queued while that claim holds.
          const [dead, delayed] = yield* claims(store)
          yield* store.release(dead!, { error: new Error('no') })
          yield* store.release(delayed!, { delayMs: LEASE })
          expect(yield* claims(store)).toEqual([])
          yield* enqueue(store, wake(second))
          expect(ids(yield* store.dead({ limit: 10 }))).toEqual([dead!.id])
          expect(yield* store.claimed([second.id])).toEqual([second.id])
          expect(Object.keys(yield* dump(prefix)).length).toBeGreaterThan(25)

          yield* store.transact(
            { families: [root.id], schedules: ['s'], scheduleNames: true },
            () => commit({ remove: [root.id], unschedule: ['s'] }, undefined),
          )
          // Counters stay: an id or a turn is never given twice.
          expect(Object.keys(yield* dump(prefix))).toEqual(['meta'])
        }),
      )

      it.effect('leave nothing of a command that was acknowledged', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const run = stored('not-stored', 0)
          yield* enqueue(store, wake(run))
          const [first] = yield* claims(store, { leaseMs: SHORT })
          yield* Effect.sleep(PAST_SHORT)
          const [second] = yield* claims(store)
          expect(second!.id).toBe(first!.id)
          yield* store.transact({}, () => commit({ ack: [second!] }, undefined))
          expect(Object.keys(yield* dump(prefix))).toEqual(['meta'])
        }),
      )
    })

    describe('the children of a map', () => {
      /** A run with a map, `each`, and a node of one child, `step`. */
      const mapped = Effect.fnUntraced(function* (store: StoreService) {
        const run = yield* create(store)
        return yield* store.transact({ runs: [run.id] }, ({ now }) => {
          const node = (
            name: string,
            kind: StoredNode['kind'],
            input: unknown,
          ): StoredNode => ({
            runId: run.id,
            name,
            kind,
            status: 'running',
            input,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          const child = (
            nodeName: string,
            childKey: string,
            status: StoredChild['status'],
            ordinal?: number,
          ): StoredChild => ({
            runId: run.id,
            nodeName,
            childKey,
            kind: 'task',
            status,
            ...(ordinal === undefined ? {} : { ordinal, item: ordinal }),
            attemptCount: 0,
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          const written = {
            run,
            each: node('each', 'mapTask', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
            step: node('step', 'task', { n: 1 }),
            children: [
              child('each', 'item:0', 'pending', 0),
              child('each', 'item:1', 'running', 1),
              child('each', 'item:2', 'completed', 2),
              child('each', 'item:10', 'pending', 10),
              child('step', '$self', 'waiting'),
            ],
          }
          return commit(
            {
              nodes: [written.each, written.step],
              children: written.children,
            },
            written,
          )
        })
      })
      const member = (key: string, ordinal: number) => [
        JSON.stringify(['each', key]),
        String(ordinal),
      ]

      it.effect('are kept by where each stands, and go with their family', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const { run, each, children } = yield* mapped(store)
          const owned = (key: string) =>
            Effect.map(dump(prefix), (contents) => contents[key])
          const { input, ...rest } = each

          // A map's input is a field of its own, read only when asked.
          const hash = (yield* owned(`run:${run.id}`)) as Record<string, string>
          expect(JSON.parse(hash.Neach!)).toStrictEqual(rest)
          expect(JSON.parse(hash.Ieach!)).toStrictEqual(input)
          expect(yield* owned(`run:${run.id}:nodes`)).toEqual(['each', 'step'])
          expect(yield* owned(`run:${run.id}:pending:each`)).toEqual([
            ...member('item:0', 0),
            ...member('item:10', 10),
          ])
          expect(yield* owned(`run:${run.id}:active:each`)).toEqual(
            member('item:1', 1),
          )
          expect(yield* owned(`run:${run.id}:all:each`)).toHaveLength(8)
          expect(yield* owned(`run:${run.id}:all:step`)).toHaveLength(2)

          // One starts, and one that ended waits again, as a retry has it.
          yield* store.transact({ runs: [run.id] }, () =>
            commit(
              {
                children: [
                  { ...children[0]!, status: 'running', version: 2 },
                  { ...children[2]!, status: 'pending', version: 2 },
                ],
              },
              undefined,
            ),
          )
          expect(yield* owned(`run:${run.id}:pending:each`)).toEqual([
            ...member('item:2', 2),
            ...member('item:10', 10),
          ])
          expect(yield* owned(`run:${run.id}:active:each`)).toEqual([
            ...member('item:0', 0),
            ...member('item:1', 1),
          ])

          yield* store.transact({ families: [run.id] }, () =>
            commit({ remove: [run.id] }, undefined),
          )
          expect(Object.keys(yield* dump(prefix))).toEqual(['meta'])
        }),
      )

      it.effect('leave no index behind of a child of no node', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const { run, children } = yield* mapped(store)
          const before = yield* dump(prefix)
          // Its family's removal finds a run's indexes by its nodes.
          const orphan = yield* Effect.exit(
            store.transact({ open: [{ runId: run.id, maps: [] }] }, () =>
              commit(
                { children: [{ ...children[0]!, nodeName: 'ghost' }] },
                undefined,
              ),
            ),
          )
          expect(died(orphan)).toBe(true)
          expect(yield* dump(prefix)).toEqual(before)
          yield* store.transact({ families: [run.id] }, () =>
            commit({ remove: [run.id] }, undefined),
          )
          expect(Object.keys(yield* dump(prefix))).toEqual(['meta'])
        }),
      )

      it.effect(
        'are written by a script that checks every number before it writes',
        () =>
          Effect.gen(function* () {
            const { prefix, store } = yield* two()
            const { run } = yield* mapped(store)
            const redis = yield* Redis.Redis
            const before = yield* dump(prefix)
            // As the adapter sends a mutation, but past its checks: the run
            // first, then what holds a value JSON has no number for.
            const body = (patch: Record<string, unknown>) =>
              JSON.stringify({
                now: 0,
                guards: [],
                acks: [],
                holds: [],
                fresh: [],
                owners: [run.id],
                remove: [],
                runs: [
                  {
                    id: run.id,
                    run: '{}',
                    io: '{}',
                    createdAt: 0,
                    updatedAt: 0,
                    terms: [],
                    ended: false,
                  },
                ],
                nodes: [],
                children: [],
                attempts: [],
                keys: [],
                definitions: [],
                schedules: [],
                unschedule: [],
                enqueue: [],
                notify: [],
                rev: 'rev',
                ...patch,
              })
            const child = (ordinal: unknown) => [
              run.id,
              '["each","item:9"]',
              '{}',
              false,
              'origin',
              'each',
              ordinal,
              'pending',
              false,
            ]
            for (const patch of [
              { children: [child(null)] },
              { children: [child(0.5)] },
              {
                runs: [
                  {
                    id: run.id,
                    run: '{}',
                    io: '{}',
                    createdAt: null,
                    updatedAt: 0,
                    terms: [],
                    ended: false,
                  },
                ],
              },
              { schedules: [{ name: 's', value: '{}', due: null }] },
              {
                enqueue: [
                  {
                    command: '{}',
                    dedupe: 'd',
                    availableAt: null,
                    kind: 'continueRun',
                    lane: 'lane',
                    runId: run.id,
                  },
                ],
              },
            ]) {
              const answer = yield* Effect.orDie(
                redis.eval(COMMIT)(`{${prefix}}`, body(patch)),
              )
              expect(answer[0], JSON.stringify(patch)).toBe('malformed')
              expect(yield* dump(prefix)).toEqual(before)
            }
          }),
      )

      it.effect(
        'of a run stored without their indexes are never read as none',
        () =>
          Effect.gen(function* () {
            const { prefix, store } = yield* two()
            const { run } = yield* mapped(store)
            const redis = yield* Redis.Redis
            yield* Effect.orDie(
              redis.send('HDEL', `{${prefix}}run:${run.id}`, 'indexed'),
            )

            for (const scope of [
              { open: [{ runId: run.id, maps: [] }] },
              { childResults: [{ runId: run.id, nodeName: 'each' }] },
              {
                units: [{ runId: run.id, nodeName: 'step', childKey: '$self' }],
              },
            ] satisfies ReadScope[]) {
              const failure = yield* Effect.flip(view(store, scope, () => 0))
              expect(failure).toBeInstanceOf(StorageError)
              expect(
                String((failure.cause as Redis.RedisError).cause),
              ).toContain('was stored without the indexes of its children')
            }
            // Whole, it is read as ever.
            expect((yield* store.load(run.id))?.children).toHaveLength(5)
          }),
      )

      it.effect(
        'are read by a pass by their indexes, never by the whole run',
        () =>
          Effect.gen(function* () {
            const { prefix, store } = yield* two()
            const served = registry([
              { kind: 'task', name: 'redis.job', execute: () => Effect.void },
              {
                kind: 'workflow',
                name: 'redis.map',
                steps: [
                  {
                    kind: 'map',
                    name: 'each',
                    items: (_outputs, input) => input as unknown[],
                    input: (_outputs, _input, item) => item,
                    target: { kind: 'task', task: { name: 'redis.job' } },
                    concurrency: 3,
                  },
                ],
                result: ({ each }) => each,
              },
            ])
            const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.provideService(effect, Store, store)
            const passes = Effect.gen(function* () {
              const claimed = yield* store.claim({
                lanes: [{ kind: 'continueRun', routes: served.workflows }],
                limit: 10,
                leaseMs: LEASE,
              })
              for (const claim of claimed)
                yield* provide(coordinate(served, claim))
            })
            const tasks = store.claim({
              lanes: [{ kind: 'runTask', routes: served.tasks }],
              limit: 10,
              leaseMs: LEASE,
            }) as Effect.Effect<readonly Claim<AttemptCommand>[], StorageError>
            const { run } = yield* provide(
              start({
                name: 'redis.map',
                input: Array.from({ length: 30 }, (_, index) => index),
              }),
            )
            yield* passes

            const lines = yield* monitor(url)
            for (let round = 0; round < 3; round++) {
              for (const claim of yield* tasks) {
                yield* provide(
                  settle(served, claim, { _tag: 'Completed', output: 1 }),
                )
              }
              yield* passes
            }
            // MONITOR shows a command a moment after the server ran it.
            yield* Effect.sleep(200)

            const ours = lines.filter((line) => line.includes(`{${prefix}}`))
            expect(ours.some((line) => /"zrange"/i.test(line))).toBe(true)
            expect(ours.filter((line) => /"hgetall"/i.test(line))).toEqual([])
            expect(
              itemsOf((yield* store.load(run.id))!).filter(
                ({ status }) => status === 'completed',
              ),
            ).toHaveLength(9)
          }),
      )
    })

    describe('one server', () => {
      it.effect('keeps stores of two prefixes apart', () =>
        Effect.gen(function* () {
          const [a, b] = [yield* two(), yield* two()]
          const hint = yield* b.store.hints(['continueRun'])
          const topic = yield* b.store.listen('topic')
          const waits = [
            yield* Effect.forkScoped(hint),
            yield* Effect.forkScoped(topic),
          ]

          const run = yield* a.store.transact(
            { keys: ['k'], schedules: ['s'], scheduleNames: true },
            ({ id, now }) => {
              const run = stored(id('run'), now)
              return commit(
                {
                  runs: [run],
                  keys: [{ op: 'acquire', key: 'k', runId: run.id }],
                  schedules: [schedule('s', now)],
                  enqueue: [wake(run)],
                  notify: ['topic'],
                },
                run,
              )
            },
          )
          yield* Effect.sleep(100)

          expect(yield* b.store.load(run.id)).toBeUndefined()
          expect(yield* b.store.runs({ limit: 10 })).toEqual({ items: [] })
          expect(yield* claims(b.store)).toEqual([])
          expect(yield* holder(b.store, 'k')).toBeUndefined()
          expect(yield* b.store.schedules({ limit: 10 })).toEqual({ items: [] })
          expect(waits.map((fiber) => fiber.pollUnsafe())).toEqual([
            undefined,
            undefined,
          ])
          expect(yield* keys(b.prefix)).toEqual([])
          // Every key is under the store's hash tag, and so in its slot.
          const owned = yield* keys(a.prefix)
          expect(owned.length).toBeGreaterThan(5)
          expect(owned.every((key) => key.startsWith(`{${a.prefix}}`))).toBe(
            true,
          )
          expect(yield* claims(a.store)).toHaveLength(1)
        }),
      )

      it.effect('refuses a prefix that would break its hash tag', () =>
        Effect.gen(function* () {
          for (const prefix of ['', 'a{b', 'a}b']) {
            const exit = yield* Effect.exit(
              Effect.scoped(RedisStore.make({ prefix })),
            )
            expect(died(exit), prefix).toBe(true)
          }
        }),
      )

      it.effect('refuses numbers that make no sense, when it is made', () =>
        Effect.gen(function* () {
          const refused = Effect.fnUntraced(function* (
            options: RedisStore.RedisOptions,
          ) {
            const exit = yield* Effect.exit(
              Effect.scoped(RedisStore.make(options)),
            )
            return String(Exit.isFailure(exit) && Cause.squash(exit.cause))
          })
          for (const value of [0, -1, 1.5, Number.NaN]) {
            expect(yield* refused({ maxDeliveries: value })).toContain(
              `maxDeliveries [${value}] must be a positive integer`,
            )
            expect(yield* refused({ maxAttempts: value })).toContain(
              `maxAttempts [${value}] must be a positive integer`,
            )
          }
        }),
      )

      it.effect('shares no key with the old engine under its prefix', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          yield* busy(store)
          // The old engine's keys are the prefix and a name: no brace.
          for (const key of yield* keys(prefix)) {
            expect(key.startsWith(prefix)).toBe(false)
          }
          expect(RedisStore.PREFIX).toBe('nmtjs:workflows:')
        }),
      )

      it.effect('hints travel from one connection to another', () =>
        Effect.gen(function* () {
          const { store, other } = yield* two()
          const run = yield* create(store)
          const hint = yield* store.hints(['continueRun'])
          const topic = yield* store.listen('run:1')
          const unheard = yield* Effect.forkScoped(yield* store.listen('run:2'))

          const [due, told] = [
            yield* Effect.forkScoped(hint),
            yield* Effect.forkScoped(topic),
          ]
          yield* other.transact({}, () =>
            commit({ enqueue: [wake(run)], notify: ['run:1'] }, undefined),
          )
          yield* Fiber.join(due)
          yield* Fiber.join(told)

          // A command given back at once is hinted from wherever it was.
          const [claim] = yield* claims(other)
          const again = yield* Effect.forkScoped(hint)
          yield* Effect.sleep(100)
          expect(again.pollUnsafe()).toBeUndefined()
          yield* other.release(claim!)
          yield* Fiber.join(again)
          expect(unheard.pollUnsafe()).toBeUndefined()
        }),
      )

      it.effect('a storage failure is a failure, not a defect', () =>
        Effect.gen(function* () {
          const { prefix, store } = yield* two()
          const redis = yield* Redis.Redis
          const run = yield* create(store)
          // A key of the store holding what the store never wrote.
          const corrupt = (key: string) =>
            Effect.orDie(
              Effect.andThen(
                redis.send('DEL', `{${prefix}}${key}`),
                redis.send('SET', `{${prefix}}${key}`, 'x'),
              ),
            )
          yield* corrupt('keys')
          yield* corrupt(`run:${run.id}`)
          yield* corrupt('runs:all')

          const failed = [
            yield* Effect.flip(holder(store, 'k')),
            yield* Effect.flip(store.load(run.id)),
            yield* Effect.flip(store.runs({ limit: 1 })),
          ]
          for (const error of failed) {
            expect(error).toBeInstanceOf(StorageError)
            expect((error as StorageError).cause).toMatchObject({
              _tag: 'RedisError',
            })
          }
        }),
      )
    })
  }
}

for (const [server, url] of SERVERS) {
  describe.skipIf(!url)(`the store on ${server}`, () => {
    layer(client(url!), options)('as the reference store', (it) => {
      rewritten(it, harness)
    })
    layer(client(url!), options)('as only it is', adapter(url!))

    it.effect(
      'reports a command queued before due times were kept as due when queued',
      () =>
        Effect.gen(function* () {
          const prefix = yield* prefixed
          const store = yield* RedisStore.make({ prefix })
          const redis = yield* Redis.Redis
          const now = yield* view(store, {}, (snapshot) => snapshot.now)
          yield* enqueue(store, { ...wake(stored('run', now)), availableAt: 1 })
          // As a release before this one queued it: without `availableAt`.
          const [key] = yield* Effect.orDie(
            redis.send<string[]>('KEYS', `{${prefix}}command:*`),
          )
          yield* Effect.orDie(redis.send('HDEL', key!, 'availableAt'))

          const [claim] = yield* claims(store)
          expect(claim!.availableAt).toBe(claim!.createdAt)
        }).pipe(Effect.scoped, Effect.provide(client(url!))),
    )

    // The test clock stands still at zero here: time that passes is the
    // server's.
    it.effect('reads the time from the server, not from its process', () =>
      Effect.gen(function* () {
        const prefix = yield* prefixed
        const store = yield* RedisStore.make({ prefix })
        const redis = yield* Redis.Redis
        const [seconds] = yield* Effect.orDie(redis.send<string[]>('TIME'))
        const now = yield* view(store, {}, (snapshot) => snapshot.now)
        expect(Math.abs(now - Number(seconds) * 1_000)).toBeLessThan(5_000)

        const run = stored('run', now)
        yield* enqueue(store, wake(run))
        const [claim] = yield* claims(store, { leaseMs: 1 })
        const command: Command = claim!.command
        expect(command).toEqual(continueRun(run))
        // The lease ends by the server's clock while this one stands.
        let again: readonly Claim[] = []
        for (let turn = 0; turn < 1_000 && again.length === 0; turn++) {
          again = yield* claims(store)
        }
        expect(again).toMatchObject([{ id: claim!.id, deliveries: 2 }])
      }).pipe(Effect.scoped, Effect.provide(client(url!))),
    )
  })
}
