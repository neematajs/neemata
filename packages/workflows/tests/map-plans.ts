import type { Vitest } from '@effect/vitest'
import type * as Scope from 'effect/Scope'
import { describe, expect } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type {
  AttemptCommand,
  Claim,
  Outcome,
  Plan,
  Planned,
  Program,
  ReadScope,
  RunRecords,
  WorkflowProgram,
} from '../src/index.ts'
import type { StoreHarness, StoreService } from './store-contract.ts'
import {
  cancel,
  Client,
  coordinate,
  drain,
  isTerminal,
  reap,
  registry,
  settle,
  start,
  Store,
  timeout,
} from '../src/index.ts'

/**
 * Maps on each adapter: what a pass of one reads, however many items it
 * has, and that reading so little decides as reading it all did.
 */

const unused = () => Effect.die('not run')
const completed = (output: unknown): Outcome => ({
  _tag: 'Completed',
  output,
})
const failed = (message: string): Outcome => ({
  _tag: 'Failed',
  error: { message },
})

const LEASE = 60_000

const job: Program = { kind: 'task', name: 'maps.job', execute: unused }
const leaf: Program = {
  kind: 'workflow',
  name: 'maps.leaf',
  steps: [
    {
      kind: 'activity',
      name: 'hold',
      execute: unused,
      input: (_outputs, input) => input,
    },
  ],
  result: ({ hold }) => hold,
}

/** A map of jobs over its run's input, `concurrency` at once. */
const over = (
  name: string,
  concurrency?: number,
  fields: Partial<WorkflowProgram> = {},
): WorkflowProgram => ({
  kind: 'workflow',
  name,
  steps: [
    {
      kind: 'map',
      name: 'each',
      items: (_outputs, input) => input as unknown[],
      input: (_outputs, _input, item) => {
        // An item that says so has an input that cannot be computed.
        if (typeof item === 'string') throw new Error(item)
        return item
      },
      target: { kind: 'task', task: { name: 'maps.job' } },
      ...(concurrency === undefined ? {} : { concurrency }),
    },
  ],
  result: ({ each }) => each,
  ...fields,
})

/** A map of child workflows that each wait, under a cancellation policy. */
const tree = (cancellation: 'propagate' | 'detach'): WorkflowProgram => ({
  kind: 'workflow',
  name: `maps.tree.${cancellation}`,
  steps: [
    {
      kind: 'map',
      name: 'each',
      items: (_outputs, input) => input as unknown[],
      input: (_outputs, _input, item) => item,
      target: {
        kind: 'workflow',
        workflow: { name: 'maps.leaf' },
        cancellation,
      },
      concurrency: 2,
    },
  ],
  result: ({ each }) => each,
})

const programs: readonly Program[] = [
  job,
  leaf,
  tree('propagate'),
  tree('detach'),
  { ...tree('detach'), name: 'maps.tree.timed', timeout: '100ms' },
  over('maps.few', 3),
  // Limits no count of items reaches, nor one past them a 32-bit integer.
  over('maps.wide', 2 ** 31 - 1),
  over('maps.widest', Number.MAX_SAFE_INTEGER),
  over('maps.pairs', 2),
  over('maps.all'),
  over('maps.timed', 2, { timeout: '100ms' }),
  {
    kind: 'workflow',
    name: 'maps.fan',
    steps: [
      {
        kind: 'parallel',
        name: 'both',
        members: {
          a: { kind: 'activity', execute: unused, input: () => 'a' },
          b: { kind: 'activity', execute: unused, input: () => 'b' },
        },
      },
      {
        kind: 'activity',
        name: 'joined',
        execute: unused,
        input: ({ both }) => both,
      },
    ],
    result: ({ joined }) => joined,
  },
  {
    kind: 'workflow',
    name: 'maps.flow',
    steps: [
      {
        kind: 'activity',
        name: 'prep',
        execute: unused,
        input: (_outputs, input) => input,
        retry: { attempts: 2 },
      },
      {
        kind: 'map',
        name: 'each',
        items: ({ prep }) => prep as unknown[],
        input: (_outputs, _input, item) => item,
        target: { kind: 'task', task: { name: 'maps.job' } },
        concurrency: 3,
      },
      {
        kind: 'activity',
        name: 'after',
        execute: unused,
        input: ({ each }) => each,
      },
    ],
    result: ({ after }) => after,
  },
]
const served = registry(programs)

/** What one plan of a pass was given of its run, and what it answered. */
type Seen = {
  readonly runs: number
  readonly heads: number
  /** Per node, the children the open read gave, and how many had ended. */
  readonly sets: Readonly<
    Record<
      string,
      {
        readonly read: number
        readonly ended: number
        readonly limit?: unknown
      }
    >
  >
  readonly attempts: number
  /** Of each node whose results were read, how many children. */
  readonly results: readonly number[]
  readonly planned: Planned<unknown, unknown>['_tag']
}

/** The store, with every plan it runs of `runId` recorded as `Seen`. */
function recording(store: StoreService) {
  const plans: Seen[] = []
  const recorded = Store.of({
    ...store,
    transact: <A, E = never>(scope: ReadScope, plan: Plan<A, E>) =>
      store.transact(scope, (snapshot) => {
        const planned = plan(snapshot)
        const [open] = snapshot.open.values()
        const sets: Record<string, Seen['sets'][string]> = {}
        for (const [name, set] of open?.childSets ?? []) {
          const read =
            set.view === 'all' ? set.children : [...set.active, ...set.pending]
          sets[name] = {
            read: read.length,
            ended: read.filter(({ status }) => isTerminal(status)).length,
            ...(set.view === 'map' ? { limit: set.pendingLimit } : {}),
          }
        }
        plans.push({
          runs: snapshot.runs.size,
          heads: snapshot.heads.size,
          sets,
          attempts: open?.attempts.length ?? 0,
          results: Array.from(
            snapshot.childResults.values(),
            ({ children }) => children.length,
          ),
          planned: planned._tag,
        })
        return planned
      }),
  })
  const through = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.map(
      Effect.provideService(
        Effect.suspend(() => {
          plans.length = 0
          return effect
        }),
        Store,
        recorded,
      ),
      (result) => ({ result, plans: [...plans] }),
    )
  return { through }
}

const passes = Effect.fnUntraced(function* () {
  const store = yield* Store
  const claims = yield* store.claim({
    lanes: [{ kind: 'continueRun', routes: served.workflows }],
    limit: 100,
    leaseMs: LEASE,
  })
  // As a coordinator does, a run a pass leaves cancelling is drained.
  for (const claim of claims) {
    const result = yield* coordinate(served, claim)
    if (result._tag === 'Advanced' && result.draining) {
      yield* drain(result.draining)
    }
  }
  return claims.length
})

/** Passes until none is due. */
const quiet = Effect.fnUntraced(function* () {
  while ((yield* passes()) > 0);
})

const attempts = (kind: AttemptCommand['kind'] = 'runTask') =>
  Effect.flatMap(Store, (store) =>
    store.claim({
      lanes: [
        kind === 'runTask'
          ? { kind, routes: served.tasks }
          : { kind, routes: served.workflows },
      ],
      limit: 100,
      leaseMs: LEASE,
    }),
  ) as Effect.Effect<readonly Claim<AttemptCommand>[], never, Store>

const records = (runId: string) =>
  Effect.flatMap(Store, (store) =>
    Effect.map(store.load(runId), (found) => found!),
  )

const node = (records: RunRecords, name: string) =>
  records.nodes.find((one) => one.name === name)!

const itemsOf = (records: RunRecords) =>
  records.children
    .filter(({ nodeName }) => nodeName === 'each')
    .toSorted((a, b) => a.ordinal! - b.ordinal!)

export function mapPlans<R>(
  it: { readonly effect: Vitest.Tester<R | Scope.Scope> },
  harness: StoreHarness<R>,
) {
  const gapped = it.effect.skipIf(!harness.gap)
  const made = Effect.fnUntraced(function* (
    options?: Parameters<StoreHarness<R>['make']>[0],
  ) {
    const { store, inGap } = yield* harness.make(options)
    const provide = <A, E, Rest>(effect: Effect.Effect<A, E, Rest>) =>
      Effect.provideService(effect, Store, store)
    return { store, inGap, provide, ...recording(store) }
  })

  describe('the passes of a map', () => {
    it.effect(
      'read the items under way and those next in line, never what ended, and start them by ordinal',
      () =>
        Effect.gen(function* () {
          const { provide, through } = yield* made()
          const items = Array.from({ length: 12 }, (_, index) => index)
          const { run } = yield* provide(
            start({ name: 'maps.flow', input: null }),
          )
          yield* provide(passes())
          // A step before the map, with an attempt history of its own.
          const [first] = yield* provide(attempts('runAttempt'))
          yield* provide(settle(served, first!, failed('once')))
          const [second] = yield* provide(attempts('runAttempt'))
          yield* provide(settle(served, second!, completed(items)))
          yield* provide(passes())

          const started: unknown[] = []
          const seen: Seen[] = []
          // How many times each pass was planned.
          const rounds: number[] = []
          for (;;) {
            const claims = yield* provide(attempts())
            if (claims.length === 0) break
            started.push(...claims.map(({ command }) => command.input))
            // Out of order: the last started ends first.
            for (const claim of claims.toReversed()) {
              yield* provide(
                settle(served, claim, completed(claim.command.input)),
              )
              const { plans } = yield* through(passes())
              seen.push(...plans)
              rounds.push(plans.length)
            }
          }

          // By ordinal, though `item:10` sorts before `item:2`.
          expect(started).toEqual(items)
          // Its children are read all once, when none is left to run.
          const completing = seen.filter(({ results }) => results.length > 0)
          expect(completing).toEqual([
            expect.objectContaining({ results: [12], planned: 'Commit' }),
          ])
          expect(seen.at(-1)).toBe(completing[0])
          // Planned once, on what one read gave it, the runs under way
          // included; the last asks for the results once besides.
          expect(rounds).toEqual([...rounds.slice(0, -1).map(() => 1), 2])
          for (const plan of seen.slice(0, -1)) {
            expect(plan).toStrictEqual({
              runs: 0,
              heads: 0,
              sets: {
                each: { read: expect.any(Number), ended: 0, limit: 3 },
              },
              // The step before the map ended: nothing of it is read.
              attempts: 0,
              results: [],
              planned: plan === seen.at(-2) ? 'Need' : 'Commit',
            })
            // Those under way, and three waiting at most.
            expect(plan.sets.each!.read).toBeLessThanOrEqual(6)
          }

          const [after] = yield* provide(attempts('runAttempt'))
          const done = yield* provide(records(run.id))
          const output = {
            items: itemsOf(done).map(({ childRunId }, index) => ({
              item: index,
              index,
              runId: childRunId,
              output: index,
            })),
          }
          expect(after!.command.input).toEqual(output)
          // Its list is as it was written, whatever was written of it since.
          expect(node(done, 'each')).toMatchObject({
            status: 'completed',
            input: items,
            output,
          })
          yield* provide(settle(served, after!, completed('done')))
          yield* provide(passes())
          expect((yield* provide(records(run.id))).run).toMatchObject({
            status: 'completed',
            output: 'done',
          })
        }),
    )

    it.effect(
      'of a map of no limit start every item at once, and fail with the first failed by ordinal once all have ended',
      () =>
        Effect.gen(function* () {
          const { provide, through } = yield* made()
          const { run } = yield* provide(
            start({ name: 'maps.all', input: [0, 1, 2, 3, 4, 5] }),
          )
          yield* provide(passes())
          const claims = yield* provide(attempts())
          expect(claims.map(({ command }) => command.input)).toEqual([
            0, 1, 2, 3, 4, 5,
          ])

          const byInput = (input: number) =>
            claims.find(({ command }) => command.input === input)!
          // The later failure ends first; siblings go on after both.
          for (const input of [4, 1, 0, 2, 3, 5]) {
            const outcome =
              input === 4 || input === 1
                ? failed(`job ${input}`)
                : completed(input)
            yield* provide(settle(served, byInput(input), outcome))
            const { plans } = yield* through(passes())
            if (input !== 5) {
              expect(plans.at(-1)?.sets.each).toMatchObject({ limit: 'all' })
            }
          }

          const ended = yield* provide(records(run.id))
          expect(itemsOf(ended).map(({ status }) => status)).toEqual([
            'completed',
            'failed',
            'completed',
            'completed',
            'failed',
            'completed',
          ])
          expect(ended.run).toMatchObject({
            status: 'failed',
            error: { message: 'job 1' },
          })
        }),
    )

    it.effect('of a map of a limit no count reaches start every item', () =>
      Effect.gen(function* () {
        const { provide } = yield* made()
        for (const name of ['maps.wide', 'maps.widest']) {
          const { run } = yield* provide(start({ name, input: [0, 1, 2] }))
          yield* provide(passes())
          const claims = yield* provide(attempts())
          expect(
            claims.map(({ command }) => command.input),
            name,
          ).toEqual([0, 1, 2])
          for (const claim of claims) {
            yield* provide(
              settle(served, claim, completed(claim.command.input)),
            )
          }
          yield* provide(quiet())
          expect((yield* provide(records(run.id))).run.status, name).toBe(
            'completed',
          )
        }
      }),
    )

    it.effect('of a map of no items complete it', () =>
      Effect.gen(function* () {
        const { provide } = yield* made()
        const { run } = yield* provide(start({ name: 'maps.all', input: [] }))
        yield* provide(passes())
        expect((yield* provide(records(run.id))).run).toMatchObject({
          status: 'completed',
          output: { items: [] },
        })
      }),
    )

    it.effect(
      'read further, twice as far each time, while items fail to start and room is left',
      () =>
        Effect.gen(function* () {
          const { provide, through } = yield* made()
          // Seven items in a row whose input cannot be computed.
          const input = [0, 1, '2', '3', '4', '5', '6', '7', '8', 9]
          const { run } = yield* provide(start({ name: 'maps.pairs', input }))
          yield* provide(passes())
          const [zero, one] = yield* provide(attempts())

          yield* provide(settle(served, zero!, completed(0)))
          const { plans } = yield* through(passes())
          // Windows of 2, 4 and 8, the runs under way read with the first.
          expect(
            plans.map(({ sets, planned }) => [sets.each?.limit, planned]),
          ).toEqual([
            [2, 'Need'],
            [4, 'Need'],
            [8, 'Commit'],
          ])
          const [nine, ...more] = yield* provide(attempts())
          expect([nine!.command.input, more]).toEqual([9, []])

          yield* provide(settle(served, one!, completed(1)))
          yield* provide(settle(served, nine!, completed(9)))
          yield* provide(quiet())
          const ended = yield* provide(records(run.id))
          // The first item by ordinal that failed, and no shorter success.
          expect(ended.run).toMatchObject({
            status: 'failed',
            error: { message: '2' },
          })
          expect(
            itemsOf(ended).filter(({ childRunId }) => childRunId).length,
          ).toBe(3)
        }),
    )

    it.effect('refuse to make up a map whose children are not its items', () =>
      Effect.gen(function* () {
        const { store, provide } = yield* made()
        const { run } = yield* provide(
          start({ name: 'maps.all', input: [1, 2, 3] }),
        )
        yield* provide(passes())
        // An item no child stands for, as a lost edge would leave it.
        yield* store.transact({ runs: [run.id] }, (snapshot) => {
          const each = node(snapshot.runs.get(run.id)!, 'each')
          return {
            _tag: 'Commit',
            mutation: {
              nodes: [
                { ...each, input: [1, 2, 3, 4], version: each.version + 1 },
              ],
            },
            result: undefined,
          }
        })
        for (const claim of yield* provide(attempts())) {
          yield* provide(settle(served, claim, completed(1)))
        }

        const exit = yield* Effect.exit(provide(passes()))
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(
          String(Cause.squash((exit as Exit.Failure<unknown, unknown>).cause)),
        ).toContain('has children that are not its items')
        const after = yield* provide(records(run.id))
        expect(node(after, 'each').status).not.toBe('completed')
        expect(after.run.status).not.toBe('completed')
      }),
    )
  })

  describe('a pass of a run opened', () => {
    it.effect(
      'starts no member of a parallel node again that completed, and computes from its output',
      () =>
        Effect.gen(function* () {
          const { provide, through } = yield* made()
          const { run } = yield* provide(start({ name: 'maps.fan', input: 0 }))
          yield* provide(passes())
          const claims = yield* provide(attempts('runAttempt'))
          const member = (input: string) =>
            claims.find(({ command }) => command.input === input)!

          yield* provide(settle(served, member('a'), completed('A')))
          const { plans } = yield* through(passes())
          // Its children were read all, the one that ended with them.
          expect(plans.at(-1)?.sets.both).toStrictEqual({ read: 2, ended: 1 })
          expect(yield* provide(attempts('runAttempt'))).toEqual([])

          yield* provide(settle(served, member('b'), completed('B')))
          yield* provide(passes())
          const [joined, ...more] = yield* provide(attempts('runAttempt'))
          expect([joined!.command.input, more]).toEqual([
            { a: 'A', b: 'B' },
            [],
          ])
          yield* provide(settle(served, joined!, completed('AB')))
          yield* provide(passes())
          expect((yield* provide(records(run.id))).run).toMatchObject({
            status: 'completed',
            output: 'AB',
          })
        }),
    )
  })

  describe('a retry of a map', () => {
    it.effect(
      'puts its earlier items back in line, keeping what completed and the runs it started',
      () =>
        Effect.gen(function* () {
          const { provide } = yield* made()
          const input = [0, 1, 2, 3, 4, 5]
          const { run } = yield* provide(start({ name: 'maps.pairs', input }))
          const ran: unknown[] = []
          /** Runs every job due, failing those `failing` names. */
          const work = (failing: readonly number[]) =>
            Effect.gen(function* () {
              for (;;) {
                yield* provide(quiet())
                const claims = yield* provide(attempts())
                if (claims.length === 0) return
                for (const { command } of claims) ran.push(command.input)
                for (const claim of claims) {
                  const item = claim.command.input as number
                  yield* provide(
                    settle(
                      served,
                      claim,
                      failing.includes(item)
                        ? failed(`job ${item}`)
                        : completed(item),
                    ),
                  )
                }
              }
            })

          yield* work([0, 3])
          const before = yield* provide(records(run.id))
          expect(before.run).toMatchObject({
            status: 'failed',
            error: { message: 'job 0' },
          })
          const childRuns = itemsOf(before).map(({ childRunId }) => childRunId)

          // Twice: the first item fails again.
          yield* provide(Client.retry(run.id))
          ran.length = 0
          yield* work([0])
          expect(ran).toEqual([0, 3])
          expect((yield* provide(records(run.id))).run.status).toBe('failed')
          yield* provide(Client.retry(run.id))
          ran.length = 0
          yield* work([])
          expect(ran).toEqual([0])

          const after = yield* provide(records(run.id))
          expect(itemsOf(after).map(({ childRunId }) => childRunId)).toEqual(
            childRuns,
          )
          expect(after.run).toMatchObject({
            status: 'completed',
            output: {
              items: input.map((item) => ({
                item,
                index: item,
                runId: childRuns[item],
                output: item,
              })),
            },
          })
        }),
    )

    it.effect(
      'observes the runs it left to themselves that ended before it was reopened',
      () =>
        Effect.gen(function* () {
          const { provide } = yield* made()
          const program = served.workflow({ name: 'maps.tree.timed' })!
          const { run } = yield* provide(
            start({ name: 'maps.tree.timed', input: [1, 2, 3] }),
          )
          yield* provide(quiet())
          yield* harness.elapse(300)
          yield* provide(timeout(program, run.id))
          yield* provide(quiet())
          const timedOut = yield* provide(records(run.id))
          expect(timedOut.run).toMatchObject({
            status: 'failed',
            error: { name: 'RunTimeout' },
          })
          const detached = itemsOf(timedOut).flatMap(({ childRunId }) =>
            childRunId === undefined ? [] : [childRunId],
          )
          expect(detached).toHaveLength(2)

          // Left to themselves, they end while their parent waits.
          for (const claim of yield* provide(attempts('runAttempt'))) {
            yield* provide(
              settle(served, claim, completed(claim.command.input)),
            )
          }
          yield* provide(quiet())
          for (const id of detached) {
            expect((yield* provide(records(id))).run.status).toBe('completed')
          }

          yield* provide(Client.retry(run.id))
          yield* provide(quiet())
          // Neither runs again: of the items, only the one never started.
          const [third, ...more] = yield* provide(attempts('runAttempt'))
          expect([third!.command.input, more]).toEqual([3, []])
          yield* provide(settle(served, third!, completed(3)))
          yield* provide(quiet())

          const done = yield* provide(records(run.id))
          const runIds = itemsOf(done).map(({ childRunId }) => childRunId)
          expect(runIds.slice(0, 2)).toEqual(detached)
          expect(done.run).toMatchObject({
            status: 'completed',
            output: {
              items: [1, 2, 3].map((item, index) => ({
                item,
                index,
                runId: runIds[index],
                output: item,
              })),
            },
          })
        }),
    )
  })

  describe('a map cancelled', () => {
    it.effect(
      'by a child run that is, while items still wait: they never start',
      () =>
        Effect.gen(function* () {
          const { provide } = yield* made()
          const { run } = yield* provide(
            start({ name: 'maps.pairs', input: [0, 1, 2, 3, 4, 5] }),
          )
          yield* provide(passes())
          const [zero, one] = yield* provide(attempts())
          yield* provide(cancel(zero!.command.runId))
          // The item's run ends once its handler has; the map then stops the
          // other item under way, whose run waits for its handler in turn.
          expect(yield* provide(settle(served, zero!, completed(0)))).toBe(
            'stale',
          )
          yield* provide(quiet())
          expect(yield* provide(settle(served, one!, completed(1)))).toBe(
            'stale',
          )
          yield* provide(quiet())

          const ended = yield* provide(records(run.id))
          expect(ended.run.status).toBe('cancelled')
          expect(node(ended, 'each').status).toBe('cancelled')
          const children = itemsOf(ended)
          expect(children.map(({ status }) => status)).toEqual(
            children.map(() => 'cancelled'),
          )
          // Only the two that were under way had runs, both stopped.
          const started = children.flatMap(({ childRunId }) =>
            childRunId === undefined ? [] : [childRunId],
          )
          expect(started).toHaveLength(2)
          for (const id of started) {
            expect((yield* provide(records(id))).run.status).toBe('cancelled')
          }
        }),
    )

    it.effect('with its run stops its child runs, but those detached', () =>
      Effect.gen(function* () {
        const { provide } = yield* made()
        for (const [policy, ends] of [
          ['propagate', 'cancelled'],
          ['detach', 'running'],
        ] as const) {
          const { run } = yield* provide(
            start({ name: `maps.tree.${policy}`, input: [1, 2, 3] }),
          )
          yield* provide(quiet())
          yield* provide(cancel(run.id))
          yield* provide(quiet())

          const ended = yield* provide(records(run.id))
          expect(ended.run.status).toBe('cancelled')
          const children = itemsOf(ended)
          expect(children.map(({ status }) => status)).toEqual([
            'cancelled',
            'cancelled',
            'cancelled',
          ])
          const started = children.flatMap(({ childRunId }) =>
            childRunId === undefined ? [] : [childRunId],
          )
          expect(started).toHaveLength(2)
          for (const id of started) {
            expect((yield* provide(records(id))).run.status, policy).toBe(ends)
          }
        }
      }),
    )

    gapped('between the pass that makes up its output and its commit', () =>
      Effect.gen(function* () {
        const { provide, inGap } = yield* made()
        const { run } = yield* provide(
          start({ name: 'maps.pairs', input: [0, 1] }),
        )
        yield* provide(passes())
        for (const claim of yield* provide(attempts())) {
          yield* provide(settle(served, claim, completed(claim.command.input)))
        }

        const acted = inGap!(Effect.orDie(provide(cancel(run.id))))
        yield* provide(passes())
        const waited = yield* acted
        yield* provide(quiet())

        // Asked first, the request is what the pass planned again on: what
        // it had not recorded of its items is cancelled with them. Asked
        // after, the run had completed, and stays so.
        const ended = yield* provide(records(run.id))
        const status = waited ? 'completed' : 'cancelled'
        expect([ended.run.status, node(ended, 'each').status]).toEqual([
          status,
          status,
        ])
        expect(itemsOf(ended).map(({ status }) => status)).toEqual([
          status,
          status,
        ])
      }),
    )
  })

  describe('a map whose run ends from outside', () => {
    gapped('by its timeout, between a pass and its commit', () =>
      Effect.gen(function* () {
        const { provide, inGap } = yield* made()
        const program = served.workflow({ name: 'maps.timed' })!
        const { run } = yield* provide(
          start({ name: 'maps.timed', input: [0, 1, 2, 3] }),
        )
        yield* provide(passes())
        const [zero, ...others] = yield* provide(attempts())
        yield* provide(settle(served, zero!, completed(0)))
        yield* harness.elapse(300)

        const acted = inGap!(Effect.orDie(provide(timeout(program, run.id))))
        yield* provide(passes())
        yield* acted
        yield* provide(quiet())
        // The handlers of the items under way end, and their runs with them.
        for (const claim of others)
          yield* provide(settle(served, claim, completed(1)))

        const ended = yield* provide(records(run.id))
        expect(ended.run).toMatchObject({
          status: 'failed',
          error: { name: 'RunTimeout' },
        })
        // Whatever the pass started before it, nothing is left running.
        for (const { status, childRunId } of itemsOf(ended)) {
          expect(isTerminal(status)).toBe(true)
          if (childRunId === undefined) continue
          expect(
            isTerminal((yield* provide(records(childRunId))).run.status),
          ).toBe(true)
        }
      }),
    )

    gapped('by the reaper of an item, between a pass and its commit', () =>
      Effect.gen(function* () {
        const { store, provide, inGap } = yield* made({ maxDeliveries: 1 })
        const { run } = yield* provide(
          start({ name: 'maps.pairs', input: [0, 1] }),
        )
        yield* provide(passes())
        const claims = yield* provide(attempts())
        const one = claims.find(({ command }) => command.input === 1)!
        const zero = claims.find(({ command }) => command.input === 0)!
        yield* store.release(zero, { error: new Error('lost') })
        // Delivered once already: set aside instead.
        expect(yield* provide(attempts())).toHaveLength(0)
        const [dead] = (yield* store.dead({ limit: 10 })).items
        yield* provide(settle(served, one, completed(1)))

        const acted = inGap!(Effect.orDie(provide(reap(dead!))))
        yield* provide(passes())
        yield* acted
        yield* provide(quiet())

        const ended = yield* provide(records(run.id))
        expect(ended.run).toMatchObject({
          status: 'failed',
          error: { message: 'lost' },
        })
        expect(itemsOf(ended).map(({ status }) => status)).toEqual([
          'failed',
          'completed',
        ])
      }),
    )
  })
}
