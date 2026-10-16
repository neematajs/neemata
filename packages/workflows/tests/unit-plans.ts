import type { Vitest } from '@effect/vitest'
import type * as Scope from 'effect/Scope'
import { describe, expect } from '@effect/vitest'
import * as Effect from 'effect/Effect'

import type {
  AttemptCommand,
  Claim,
  Outcome,
  Plan,
  Planned,
  Program,
  ReadScope,
} from '../src/index.ts'
import type { StoreHarness, StoreService } from './store-contract.ts'
import {
  begin,
  cancel,
  coordinate,
  drain,
  reap,
  registry,
  remove,
  retry,
  settle,
  StaleClaim,
  start,
  Store,
  timeout,
} from '../src/index.ts'
import { unitOf } from '../src/plan/attempt.ts'
import { uniqueKey } from '../src/plan/keys.ts'
import { unitKey } from '../src/store.ts'
import { drainCancellations } from '../src/worker/maintenance.ts'

/**
 * Begin and settle on each adapter: what a plan of one attempt loads, and
 * that the claim still fences it however little it loads.
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
/** A lease a test waits out, and the wait. */
const SHORT = 200
const PAST_SHORT = 300
const BACKOFF = 1_000

const programs: readonly Program[] = [
  {
    kind: 'workflow',
    name: 'units.flow',
    steps: [
      {
        kind: 'activity',
        name: 'charge',
        execute: unused,
        input: (_outputs, input) => input,
        retry: { attempts: 2, delay: `${BACKOFF}ms` },
      },
    ],
    result: ({ charge }) => charge,
  },
  {
    kind: 'workflow',
    name: 'units.fan',
    steps: [
      {
        kind: 'parallel',
        name: 'both',
        members: {
          a: { kind: 'activity', execute: unused, input: () => 'a' },
          b: { kind: 'activity', execute: unused, input: () => 'b' },
        },
      },
    ],
    result: ({ both }) => both,
  },
  {
    kind: 'workflow',
    name: 'units.timed',
    timeout: `${BACKOFF}ms`,
    steps: [
      {
        kind: 'activity',
        name: 'charge',
        execute: unused,
        input: (_outputs, input) => input,
      },
    ],
    result: ({ charge }) => charge,
  },
  {
    kind: 'task',
    name: 'units.job',
    execute: unused,
    retry: { attempts: 8 },
  },
]
const served = registry(programs)

/** What the store gave a plan, and what the plan answered. */
type Seen = {
  readonly runs: readonly string[]
  readonly heads: readonly string[]
  readonly units: readonly string[]
  readonly keys: readonly string[]
  readonly planned: Planned<unknown, unknown>['_tag']
}

/** The store, with every plan it runs recorded as `Seen`. */
function recording(store: StoreService) {
  const plans: Seen[] = []
  const recorded = Store.of({
    ...store,
    transact: <A, E = never>(scope: ReadScope, plan: Plan<A, E>) =>
      store.transact(scope, (snapshot) => {
        const planned = plan(snapshot)
        plans.push({
          runs: Array.from(snapshot.runs.keys()),
          heads: Array.from(snapshot.heads.keys()),
          units: Array.from(snapshot.units.keys()),
          keys: Array.from(snapshot.keys.keys()),
          planned: planned._tag,
        })
        return planned
      }),
  })
  /** The plans `effect` ran. */
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

/** A plan that loaded the attempt's unit and nothing else, and committed. */
const unitAlone = (claim: Claim<AttemptCommand>): Seen => ({
  runs: [],
  heads: [],
  units: [unitKey(unitOf(claim.command))],
  keys: [],
  planned: 'Commit',
})

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

const attempts = (leaseMs = LEASE) =>
  Effect.flatMap(Store, (store) =>
    store.claim({
      lanes: [
        { kind: 'runAttempt', routes: served.workflows },
        { kind: 'runTask', routes: served.tasks },
      ],
      limit: 100,
      leaseMs,
    }),
  ) as Effect.Effect<readonly Claim<AttemptCommand>[], never, Store>

/** Coordinates until no pass is left. */
const quiet = Effect.fnUntraced(function* () {
  while ((yield* passes()) > 0);
})

const records = (runId: string) =>
  Effect.flatMap(Store, (store) =>
    Effect.map(store.load(runId), (found) => found!),
  )

export function unitPlans<R>(
  it: { readonly effect: Vitest.Tester<R | Scope.Scope> },
  harness: StoreHarness<R>,
) {
  const gapped = it.effect.skipIf(!harness.gap)
  const made = Effect.fnUntraced(function* (
    options?: Parameters<StoreHarness<R>['make']>[0],
  ) {
    const { store, inGap } = yield* harness.make(options)
    return { store, inGap, ...recording(store) }
  })
  const provided =
    (store: StoreService) =>
    <A, E, Rest>(effect: Effect.Effect<A, E, Rest>) =>
      Effect.provideService(effect, Store, store)

  describe('the plans of an attempt', () => {
    it.effect('begin and settle an activity from its unit alone', () =>
      Effect.gen(function* () {
        const { store, through } = yield* made()
        const provide = provided(store)
        const { run } = yield* provide(start({ name: 'units.flow', input: 7 }))
        yield* provide(passes())
        const [claim] = yield* provide(attempts())

        const begun = yield* through(begin(served, claim!))
        expect(begun.result).toMatchObject({ _tag: 'Begun' })
        expect(begun.plans).toStrictEqual([unitAlone(claim!)])
        const settled = yield* through(settle(served, claim!, completed(70)))
        expect(settled).toStrictEqual({
          result: 'settled',
          plans: [unitAlone(claim!)],
        })

        // The node the unit had was settled with it: the pass ends the run.
        yield* provide(passes())
        expect((yield* provide(records(run.id))).run).toMatchObject({
          status: 'completed',
          output: 70,
        })
      }),
    )

    it.effect(
      'settle a parallel member from its unit, the node left to the pass',
      () =>
        Effect.gen(function* () {
          const { store, through } = yield* made()
          const provide = provided(store)
          const { run } = yield* provide(start({ name: 'units.fan', input: 0 }))
          yield* provide(passes())
          const claims = yield* provide(attempts())
          expect(claims).toHaveLength(2)

          for (const claim of claims) {
            expect(yield* through(begin(served, claim))).toMatchObject({
              plans: [unitAlone(claim)],
            })
            expect(
              yield* through(
                settle(served, claim, completed(claim.command.input)),
              ),
            ).toStrictEqual({ result: 'settled', plans: [unitAlone(claim)] })
            expect((yield* provide(records(run.id))).nodes).toMatchObject([
              { name: 'both', status: 'running' },
            ])
          }
          yield* provide(passes())
          expect((yield* provide(records(run.id))).run).toMatchObject({
            status: 'completed',
            output: { a: 'a', b: 'b' },
          })
        }),
    )

    it.effect(
      'retry from the unit, on the attempt’s input, after the backoff',
      () =>
        Effect.gen(function* () {
          const { store, through } = yield* made()
          const provide = provided(store)
          const input = { cents: 100, note: null }
          const { run } = yield* provide(start({ name: 'units.flow', input }))
          yield* provide(passes())
          const [first] = yield* provide(attempts())

          expect(
            yield* through(settle(served, first!, failed('busy'))),
          ).toStrictEqual({ result: 'retrying', plans: [unitAlone(first!)] })
          const retried = yield* provide(records(run.id))
          const successor = retried.attempts.find(
            ({ id }) => id !== first!.command.attemptId,
          )
          expect(successor).toMatchObject({
            attemptNumber: 2,
            retryAttemptNumber: 2,
            status: 'started',
            input,
          })
          expect(retried.children).toMatchObject([
            { currentAttemptId: successor!.id, attemptCount: 2 },
          ])

          // Not delivered before the backoff.
          expect(yield* provide(attempts())).toStrictEqual([])
          yield* harness.elapse(BACKOFF + 100)
          const [second] = yield* provide(attempts())
          expect(second!.command).toMatchObject({
            attemptId: successor!.id,
            input,
          })
          expect(
            yield* through(settle(served, second!, completed(1))),
          ).toStrictEqual({ result: 'settled', plans: [unitAlone(second!)] })
        }),
    )

    it.effect(
      'settle a task of a long history from its unit, and load its key only to free it',
      () =>
        Effect.gen(function* () {
          const { store, through } = yield* made()
          const provide = provided(store)
          const unique = { key: ['units', 'job'] }
          const { run } = yield* provide(
            start({ kind: 'task', name: 'units.job', input: 1, unique }),
          )

          for (let failures = 0; failures < 6; failures++) {
            const [claim] = yield* provide(attempts())
            expect(
              yield* through(settle(served, claim!, failed('no'))),
            ).toStrictEqual({ result: 'retrying', plans: [unitAlone(claim!)] })
          }
          const [last] = yield* provide(attempts())
          expect((yield* provide(records(run.id))).attempts).toHaveLength(7)

          // Ending the run frees its key, which it asks for then: the
          // attempts before it are never read.
          const key = uniqueKey({ key: unique.key, scope: 'active' })
          expect(
            yield* through(settle(served, last!, completed('done'))),
          ).toStrictEqual({
            result: 'settled',
            plans: [
              { ...unitAlone(last!), planned: 'Need' },
              { ...unitAlone(last!), keys: [key] },
            ],
          })
          expect((yield* provide(records(run.id))).run).toMatchObject({
            status: 'completed',
            output: 'done',
          })
          const again = yield* provide(
            start({ kind: 'task', name: 'units.job', input: 2, unique }),
          )
          expect(again.created).toBe(true)
        }),
    )

    it.effect('a delivery that lost its claim neither begins nor settles', () =>
      Effect.gen(function* () {
        const { store } = yield* made()
        const provide = provided(store)
        const { run } = yield* provide(start({ name: 'units.flow', input: 1 }))
        yield* provide(passes())
        const before = yield* provide(records(run.id))

        const lose = {
          expired: (_claim: Claim) => harness.elapse(PAST_SHORT),
          released: (claim: Claim) => Effect.orDie(store.release(claim)),
          reclaimed: (_claim: Claim) =>
            Effect.andThen(harness.elapse(PAST_SHORT), provide(attempts())),
        }
        for (const [how, lost] of Object.entries(lose)) {
          const [claim] = yield* provide(attempts(SHORT))
          yield* lost(claim!)
          const stale = new StaleClaim({ commandId: claim!.id })
          expect(
            yield* Effect.flip(provide(begin(served, claim!))),
            how,
          ).toEqual(stale)
          // A failure that would have queued a retry, and an outcome.
          for (const outcome of [failed('late'), completed('late')]) {
            expect(
              yield* Effect.flip(provide(settle(served, claim!, outcome))),
              how,
            ).toEqual(stale)
          }
        }

        // No outcome, no successor and no wake: the run is as it was.
        expect(yield* provide(records(run.id))).toStrictEqual(before)
        expect(yield* provide(passes())).toBe(0)
      }),
    )

    it.effect('a settle after the run was asked to stop is stale', () =>
      Effect.gen(function* () {
        const { store } = yield* made()
        const provide = provided(store)
        const { run } = yield* provide(start({ name: 'units.flow', input: 1 }))
        yield* provide(passes())
        const [claim] = yield* provide(attempts())
        yield* provide(cancel(run.id))

        expect(yield* provide(settle(served, claim!, completed(1)))).toBe(
          'stale',
        )
        // Acknowledged, and nothing recorded: the pass cancels the attempt.
        expect(yield* provide(attempts())).toStrictEqual([])
        yield* provide(passes())
        const {
          run: ended,
          nodes,
          attempts: tried,
        } = yield* provide(records(run.id))
        expect(ended.status).toBe('cancelled')
        expect(nodes).toMatchObject([{ status: 'cancelled' }])
        expect(tried).toMatchObject([{ status: 'cancelled' }])
      }),
    )

    gapped('a cancellation between a settle and its commit', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* made()
        const provide = provided(store)
        const { run } = yield* provide(start({ name: 'units.flow', input: 1 }))
        yield* provide(passes())
        const [claim] = yield* provide(attempts())

        const acted = inGap!(Effect.orDie(provide(cancel(run.id))))
        const settled = yield* provide(settle(served, claim!, completed(1)))
        yield* acted
        while ((yield* provide(passes())) > 0);

        // The settle planned again on the request, or the request came after
        // the outcome: never an outcome recorded for a run that dropped it.
        const {
          run: ended,
          nodes,
          attempts: tried,
        } = yield* provide(records(run.id))
        expect(ended.status).toBe('cancelled')
        expect({
          settled,
          node: nodes[0]!.status,
          attempt: tried[0]!.status,
        }).toStrictEqual(
          settled === 'stale'
            ? { settled, node: 'cancelled', attempt: 'cancelled' }
            : { settled, node: 'completed', attempt: 'completed' },
        )
      }),
    )

    gapped('two members of a parallel node settled at once', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* made()
        const provide = provided(store)
        const { run } = yield* provide(start({ name: 'units.fan', input: 0 }))
        yield* provide(passes())
        const [first, second] = yield* provide(attempts())

        const acted = inGap!(
          Effect.orDie(provide(settle(served, second!, completed('b')))),
        )
        const settled = yield* provide(settle(served, first!, completed('a')))
        yield* acted
        expect(settled).toBe('settled')

        // Neither outcome is lost to the other's commit.
        const { children, attempts: tried } = yield* provide(records(run.id))
        expect(children.map(({ status }) => status)).toEqual([
          'completed',
          'completed',
        ])
        expect(tried.map(({ status }) => status)).toEqual([
          'completed',
          'completed',
        ])
        yield* provide(quiet())
        expect((yield* provide(records(run.id))).run).toMatchObject({
          status: 'completed',
          output: { a: 'a', b: 'b' },
        })
      }),
    )

    gapped(
      'a settle and the reaping of a sibling between it and its commit',
      () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* made({ maxDeliveries: 1 })
          const provide = provided(store)
          const { run } = yield* provide(start({ name: 'units.fan', input: 0 }))
          yield* provide(passes())
          const claims = yield* provide(attempts())
          const lost = claims.find(({ command }) => command.input === 'a')!
          const held = claims.find(({ command }) => command.input === 'b')!
          yield* store.release(lost, { error: new Error('lost') })
          // Delivered once already: set aside instead.
          expect(yield* provide(attempts())).toHaveLength(0)
          const [dead] = (yield* store.dead({ limit: 10 })).items

          const acted = inGap!(Effect.orDie(provide(reap(dead!))))
          const settled = yield* provide(settle(served, held, completed('b')))
          yield* acted
          expect(settled).toBe('settled')

          const sorted = (yield* provide(records(run.id))).children.map(
            ({ childKey, status }) => [childKey, status],
          )
          expect(Object.fromEntries(sorted)).toEqual({
            'member:a': 'failed',
            'member:b': 'completed',
          })
          yield* provide(quiet())
          expect((yield* provide(records(run.id))).run).toMatchObject({
            status: 'failed',
            error: { message: 'lost' },
          })
        }),
    )

    gapped('a timeout between a settle and its commit', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* made()
        const provide = provided(store)
        const program = served.workflow({ name: 'units.timed' })!
        const { run } = yield* provide(start({ name: 'units.timed', input: 1 }))
        yield* provide(passes())
        const [claim] = yield* provide(attempts())
        yield* harness.elapse(BACKOFF + 100)

        const acted = inGap!(Effect.orDie(provide(timeout(program, run.id))))
        const settled = yield* provide(settle(served, claim!, completed(1)))
        yield* acted
        yield* provide(quiet())

        // Timed out either way, with the outcome kept only when it was first.
        const { run: ended, attempts: tried } = yield* provide(records(run.id))
        expect(ended).toMatchObject({
          status: 'failed',
          error: { name: 'RunTimeout' },
        })
        expect({ settled, attempt: tried[0]!.status }).toStrictEqual(
          settled === 'stale'
            ? { settled, attempt: 'cancelled' }
            : { settled, attempt: 'completed' },
        )
      }),
    )

    gapped(
      'a reopening between a settle of the attempt it replaced and its commit',
      () =>
        Effect.gen(function* () {
          const { store, inGap } = yield* made()
          const provide = provided(store)
          const program = served.workflow({ name: 'units.timed' })!
          const { run } = yield* provide(
            start({ name: 'units.timed', input: 1 }),
          )
          yield* provide(passes())
          const [claim] = yield* provide(attempts())
          yield* harness.elapse(BACKOFF + 100)
          expect(yield* provide(timeout(program, run.id))).toBe(true)
          yield* provide(quiet())

          const acted = inGap!(Effect.orDie(provide(retry(run.id))))
          // Of a run that failed, or of an attempt its reopening replaced.
          expect(yield* provide(settle(served, claim!, completed(1)))).toBe(
            'stale',
          )
          yield* acted
          yield* provide(quiet())

          const {
            run: reopened,
            children,
            attempts: tried,
          } = yield* provide(records(run.id))
          expect(reopened.status).not.toBe('failed')
          const current = tried.find(
            ({ id }) => id === children[0]!.currentAttemptId,
          )
          expect(current).toMatchObject({ status: 'started', attemptNumber: 2 })
          expect(
            tried.find(({ id }) => id === claim!.command.attemptId)?.status,
          ).toBe('cancelled')
          const [next] = yield* provide(attempts())
          expect(next!.command.attemptId).toBe(current!.id)
        }),
    )

    gapped('a removal of the family between a late settle and its commit', () =>
      Effect.gen(function* () {
        const { store, inGap } = yield* made()
        const provide = provided(store)
        const { run } = yield* provide(start({ name: 'units.flow', input: 1 }))
        yield* provide(passes())
        const [claim] = yield* provide(attempts(SHORT))
        yield* provide(cancel(run.id))
        yield* provide(quiet())
        // The claim's lease ends, and the sweep ends the run that waited for
        // it: the family may go.
        yield* harness.elapse(PAST_SHORT)
        expect(yield* provide(drainCancellations())).toStrictEqual({
          drained: 1,
        })

        const acted = inGap!(Effect.orDie(provide(remove(run.id))))
        const settled = yield* Effect.flip(
          provide(settle(served, claim!, completed(1))),
        )
        yield* acted
        expect(settled).toEqual(new StaleClaim({ commandId: claim!.id }))
        expect(yield* store.load(run.id)).toBeUndefined()
      }),
    )
  })
}
