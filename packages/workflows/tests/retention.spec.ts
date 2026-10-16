import { describe, expect, it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import type {
  Outcome,
  Program,
  Registry,
  StartInput,
  WorkflowProgram,
} from '../src/index.ts'
import {
  cancel,
  Client,
  registry,
  RunBusy,
  RunNotRoot,
  settle,
  start,
  Store,
  Worker,
} from '../src/index.ts'
import {
  claimAttempts,
  completed,
  elapse,
  failed,
  idle,
  LEASE,
  load,
  pass,
  setup,
  unused,
} from './support.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** One activity, whose output is the run's. */
const child: WorkflowProgram = {
  kind: 'workflow',
  name: 'child',
  steps: [
    {
      kind: 'activity',
      name: 'act',
      execute: unused,
      input: (_outputs, input) => input,
    },
  ],
  result: ({ act }) => act,
  definition: { graphHash: 'child-graph', records: [] },
}

/** A parent of one child run, which it may leave running when it stops. */
const parent = (cancellation?: 'detach'): WorkflowProgram => ({
  kind: 'workflow',
  name: 'parent',
  steps: [
    {
      kind: 'workflow',
      name: 'sub',
      workflow: { name: 'child' },
      input: (_outputs, input) => input,
      ...(cancellation === undefined ? {} : { cancellation }),
    },
  ],
  result: ({ sub }) => sub,
  definition: {
    graphHash: 'parent-graph',
    presentation: { title: 'Parent' },
    records: [{ key: 'graph:parent-graph', value: { nodes: ['sub'] } }],
  },
})

const job: Program = { kind: 'task', name: 'job', execute: unused }

const programs: readonly Program[] = [parent(), child, job]

/** Works everything that is due, settling each attempt the same way. */
const drain = Effect.fnUntraced(function* (
  served: Registry,
  outcome: Outcome = completed('done'),
) {
  for (;;) {
    const passed = yield* pass(served)
    const claims = yield* claimAttempts(served)
    for (const claim of claims) yield* settle(served, claim, outcome)
    if (passed === 0 && claims.length === 0) return
  }
})

/** A parent run and its child, both ended the way `outcome` says. */
const ended = Effect.fnUntraced(function* (
  served: Registry,
  outcome?: Outcome,
  input: Partial<StartInput> = {},
) {
  const { run } = yield* start({
    name: 'parent',
    definition: parent().definition,
    input: 1,
    ...input,
  })
  yield* drain(served, outcome)
  const family = yield* Client.getFamily(run.id)
  return { root: run.id, child: family[1]!.run.id }
})

const exists = (runId: string) =>
  Effect.map(Client.get(runId), (records) => records !== undefined)

describe('deleting a run', () => {
  it.effect('answers that nothing was deleted for a run that is not', () => {
    const { provide } = setup(programs)
    return provide(
      Effect.gen(function* () {
        expect(yield* Client.deleteRun('missing')).toEqual({ deleted: false })
      }),
    )
  })

  it.effect('removes the family of a root with all it left behind', () => {
    const { served, provide, inspect } = setup(programs, { maxDeliveries: 1 })
    const keys = {
      idempotencyKey: ['order', 1],
      unique: { key: ['customer', 1], scope: 'all' },
    } as const

    return provide(
      Effect.gen(function* () {
        const kept = yield* ended(served)
        // A family that failed for an attempt that was set aside: its dead
        // command is what is left of it in the queue.
        const failing = Effect.fnUntraced(function* (
          input?: Partial<StartInput>,
        ) {
          const { run } = yield* start({
            name: 'parent',
            definition: parent().definition,
            input: 1,
            ...input,
          })
          yield* pass(served)
          yield* pass(served)
          yield* claimAttempts(served)
          yield* TestClock.adjust(LEASE)
          yield* claimAttempts(served)
          yield* Worker.reapDeadCommands()
          yield* drain(served)
          const [, { run: under }] = yield* Client.getFamily(run.id)
          return { root: run.id, child: under.id }
        })
        const gone = yield* failing(keys)
        const other = yield* failing()
        expect((yield* load(gone.root)).run.status).toBe('failed')
        expect(inspect.dead()).toHaveLength(2)
        expect(inspect.keys().size).toBe(2)

        expect(yield* Client.deleteRun(gone.root)).toEqual({ deleted: true })

        expect(yield* exists(gone.root)).toBe(false)
        expect(yield* exists(gone.child)).toBe(false)
        expect(inspect.runs().map(({ run }) => run.id)).toEqual([
          kept.root,
          kept.child,
          other.root,
          other.child,
        ])
        // Other families keep what they own, and their dead commands.
        expect((yield* load(kept.root)).nodes).toHaveLength(1)
        expect(inspect.dead()).toMatchObject([
          { command: { runId: other.child } },
        ])
        expect(inspect.keys().size).toBe(0)
        // Saved definitions are shared, and stay.
        expect(inspect.definitions().get('graph:parent-graph')).toEqual({
          nodes: ['sub'],
        })

        // The keys it held are free: the same start makes a new run.
        const again = yield* start({ name: 'parent', input: 1, ...keys })
        expect(again.created).toBe(true)
        expect(yield* Client.deleteRun(gone.root)).toEqual({ deleted: false })
      }),
    )
  })

  it.effect('takes the queued commands of the family with it', () => {
    const { served, provide, inspect } = setup(programs)
    return provide(
      Effect.gen(function* () {
        const { root, child } = yield* ended(served)
        // A parent is woken again by a pass of its ended child.
        yield* Effect.flatMap(Store, (store) =>
          store.transact({}, () => ({
            _tag: 'Commit',
            mutation: {
              enqueue: [
                {
                  command: { kind: 'continueRun', runId: child, name: 'child' },
                  dedupe: `continue:${child}`,
                  availableAt: Number.MAX_SAFE_INTEGER,
                },
              ],
            },
            result: undefined,
          })),
        )
        expect(inspect.queue()).toHaveLength(1)

        yield* Client.deleteRun(root)
        expect(inspect.queue()).toEqual([])
      }),
    )
  })

  it.effect('refuses a run that is not a root', () => {
    const { served, provide } = setup(programs)
    return provide(
      Effect.gen(function* () {
        const { root, child } = yield* ended(served)
        const error = yield* Effect.flip(Client.deleteRun(child))
        expect(error).toEqual(new RunNotRoot({ runId: child }))
        expect(error.message).toBe(`Run [${child}] is not a root run`)
        expect(yield* exists(root)).toBe(true)
        expect(yield* exists(child)).toBe(true)
      }),
    )
  })

  it.effect('refuses a family with a run that has not ended', () => {
    const { served, provide } = setup([parent('detach'), child])
    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'parent', input: 1 })
        yield* pass(served)
        const [, { run: detached }] = yield* Client.getFamily(run.id)
        // The root ends; the child it detached goes on.
        yield* Client.cancel(run.id)
        yield* pass(served)
        expect((yield* load(run.id)).run.status).toBe('cancelled')
        expect((yield* load(detached.id)).run.status).not.toBe('cancelled')

        const error = yield* Effect.flip(Client.deleteRun(run.id))
        expect(error).toEqual(
          new RunBusy({ runId: run.id, busyRunId: detached.id }),
        )
        expect(error.message).toBe(
          `Run family [${run.id}] still has active work in run [${detached.id}]`,
        )
        expect(yield* exists(run.id)).toBe(true)

        yield* drain(served)
        expect(yield* Client.deleteRun(run.id)).toEqual({ deleted: true })
        expect(yield* exists(detached.id)).toBe(false)
      }),
    )
  })

  it.effect('refuses a family a worker still holds a command of', () => {
    const { served, provide } = setup(programs)
    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'parent', input: 1 })
        yield* pass(served)
        yield* pass(served)
        // A handler is running when the family is cancelled around it.
        const [claim] = yield* claimAttempts(served)
        yield* Client.cancel(run.id)
        // The parent's, then the child's: the child waits for the handler,
        // and the parent for the child.
        yield* pass(served)
        yield* pass(served)
        const family = yield* Client.getFamily(run.id)
        expect(family.map(({ run }) => run.status)).toEqual([
          'cancelling',
          'cancelling',
        ])
        expect(yield* Effect.flip(Client.deleteRun(run.id))).toEqual(
          new RunBusy({ runId: run.id, busyRunId: run.id }),
        )

        // Its lease over, nothing holds the family any more: the sweep ends
        // the child, and the parent with it.
        yield* TestClock.adjust(LEASE)
        expect(yield* Worker.drainCancellations()).toEqual({ drained: 2 })
        expect(
          (yield* Client.getFamily(run.id)).map(({ run }) => run.status),
        ).toEqual(['cancelled', 'cancelled'])
        expect(claim!.command.runId).not.toBe(run.id)
        expect(yield* Client.deleteRun(run.id)).toEqual({ deleted: true })
      }),
    )
  })
})

describe('pruning', () => {
  const cutoff = Effect.map(Clock.currentTimeMillis, (now) => now + 1)

  it.effect(
    'removes the families of old roots that ended, and no other',
    () => {
      const { served, provide, inspect } = setup(programs)
      return provide(
        Effect.gen(function* () {
          const old = yield* ended(served)
          const lost = yield* ended(served, failed('no'))
          const { run: live } = yield* start({ name: 'parent', input: 1 })
          yield* pass(served)
          yield* TestClock.adjust(DAY)
          const recent = yield* ended(served)

          const olderThan = (yield* Clock.currentTimeMillis) - HOUR
          expect(yield* Client.pruneRuns({ olderThan })).toEqual({ deleted: 2 })
          expect(inspect.runs().map(({ run }) => run.id)).toEqual(
            expect.arrayContaining([live.id, recent.root, recent.child]),
          )
          expect(inspect.runs()).toHaveLength(4)
          expect(yield* exists(old.child)).toBe(false)
          expect(yield* exists(lost.root)).toBe(false)
          // Old as it is, a family in flight is never old enough.
          expect(yield* exists(live.id)).toBe(true)
          expect(yield* Client.pruneRuns({ olderThan })).toEqual({ deleted: 0 })
        }),
      )
    },
  )

  it.effect('removes only roots that ended in the statuses it is given', () => {
    const { served, provide } = setup(programs)
    return provide(
      Effect.gen(function* () {
        const done = yield* ended(served)
        const lost = yield* ended(served, failed('no'))
        const { run: stopped } = yield* start({ name: 'parent', input: 1 })
        yield* Client.cancel(stopped.id)
        yield* drain(served)
        const { run: live } = yield* start({ name: 'parent', input: 1 })
        const olderThan = yield* cutoff

        expect(yield* Client.pruneRuns({ olderThan, statuses: [] })).toEqual({
          deleted: 0,
        })
        // A status no run ends in selects none: what is in flight stays.
        expect(
          yield* Client.pruneRuns({ olderThan, statuses: ['queued' as never] }),
        ).toEqual({ deleted: 0 })
        expect(yield* exists(live.id)).toBe(true)

        expect(
          yield* Client.pruneRuns({ olderThan, statuses: ['failed'] }),
        ).toEqual({ deleted: 1 })
        expect(yield* exists(lost.root)).toBe(false)
        expect(
          yield* Client.pruneRuns({
            olderThan,
            statuses: ['cancelled', 'completed'],
          }),
        ).toEqual({ deleted: 2 })
        expect(yield* exists(done.root)).toBe(false)
        expect(yield* exists(stopped.id)).toBe(false)
      }),
    )
  })

  it.effect('keeps an ended root while a run under it goes on', () => {
    const { served, provide } = setup([parent('detach'), child])
    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'parent', input: 1 })
        yield* pass(served)
        yield* Client.cancel(run.id)
        yield* pass(served)
        yield* TestClock.adjust(DAY)
        const olderThan = yield* cutoff

        expect(yield* Client.pruneRuns({ olderThan })).toEqual({ deleted: 0 })
        expect((yield* Client.getFamily(run.id)).length).toBe(2)

        yield* drain(served)
        expect(yield* Client.pruneRuns({ olderThan })).toEqual({ deleted: 1 })
        expect(yield* Client.getFamily(run.id)).toEqual([])
      }),
    )
  })

  it.effect('reads a batch at a time until none is left that may go', () => {
    const { served, provide, store } = setup(programs)
    const reads: number[] = []
    const counting = Store.of({
      ...store,
      prunable: (query) =>
        Effect.tap(store.prunable(query), ({ items }) =>
          Effect.sync(() => {
            reads.push(items.length)
            expect(query.limit).toBe(2)
          }),
        ),
    })

    return provide(
      Effect.gen(function* () {
        for (let made = 0; made < 5; made++) yield* ended(served)
        // One asked to stop while its handler runs has not ended: it is not
        // among those that may go.
        const { run: held } = yield* start({
          kind: 'task',
          name: 'job',
          input: 1,
        })
        yield* claimAttempts(served)
        yield* cancel(held.id)

        expect(
          yield* Effect.provideService(
            Client.pruneRuns({
              olderThan: yield* cutoff,
              statuses: ['completed', 'cancelled'],
              batchSize: 2,
            }),
            Store,
            counting,
          ),
        ).toEqual({ deleted: 5 })
        // Three pages of those that completed, an empty one of those
        // cancelled.
        expect(reads).toEqual([2, 2, 1, 0])
        expect(yield* exists(held.id)).toBe(true)
      }),
    )
  })

  it.effect('reads nothing for a batch of none', () => {
    const { served, provide, store } = setup(programs)
    const silent = Store.of({
      ...store,
      prunable: () => Effect.die('not read'),
    })

    return provide(
      Effect.gen(function* () {
        const { root } = yield* ended(served)
        expect(
          yield* Effect.provideService(
            Client.pruneRuns({ olderThan: yield* cutoff, batchSize: 0 }),
            Store,
            silent,
          ),
        ).toEqual({ deleted: 0 })
        expect(yield* exists(root)).toBe(true)
      }),
    )
  })

  it.effect('refuses a batch size it cannot use before it deletes', () => {
    const { served, provide } = setup(programs)
    return provide(
      Effect.gen(function* () {
        const { root } = yield* ended(served)
        const olderThan = yield* cutoff
        for (const batchSize of [
          -1,
          1.5,
          Number.NaN,
          Infinity,
          Number.MAX_SAFE_INTEGER + 1,
        ]) {
          expect(() => Client.pruneRuns({ olderThan, batchSize })).toThrow(
            new RangeError(
              'Retention batchSize must be a non-negative safe integer',
            ),
          )
        }
        expect(yield* exists(root)).toBe(true)
      }),
    )
  })

  describe('decides again on each root the sweep found', () => {
    /** A store that runs `act` once, before the next removal commits. */
    function gapped() {
      let pending: Effect.Effect<unknown> | undefined
      const made = setup(programs, {
        beforeCommit: (mutation) => {
          if (!mutation.remove?.length) return
          const act = pending
          pending = undefined
          if (act) Effect.runSync(act)
        },
      })
      const inGap = (act: Effect.Effect<unknown, unknown, Store>) =>
        Effect.clockWith((clock) =>
          Effect.sync(() => {
            pending = Effect.orDie(act).pipe(
              Effect.provideService(Store, made.store),
              Effect.provideService(Clock.Clock, clock),
            )
          }),
        )
      return { ...made, inGap }
    }

    it.effect('one that a retry reopened meanwhile stays', () => {
      const { served, provide, inGap } = gapped()
      return provide(
        Effect.gen(function* () {
          const { root, child } = yield* ended(served, failed('no'))
          yield* inGap(Client.retry(root))

          expect(yield* Client.pruneRuns({ olderThan: yield* cutoff })).toEqual(
            { deleted: 0 },
          )
          expect((yield* load(root)).run.status).toBe('queued')
          expect(yield* exists(child)).toBe(true)
        }),
      )
    })

    it.effect('one that was written meanwhile is no longer old', () => {
      const { served, provide, inGap, store } = gapped()
      return provide(
        Effect.gen(function* () {
          const { root } = yield* ended(served)
          const olderThan = yield* cutoff
          yield* TestClock.adjust(HOUR)
          // Rewritten as it is, at the later time.
          yield* inGap(
            store.transact({ runs: [root] }, (snapshot) => {
              const { run } = snapshot.runs.get(root)!
              return {
                _tag: 'Commit',
                mutation: { runs: [{ ...run, updatedAt: snapshot.now }] },
                result: undefined,
              }
            }),
          )

          expect(yield* Client.pruneRuns({ olderThan })).toEqual({ deleted: 0 })
          expect(yield* exists(root)).toBe(true)
        }),
      )
    })
  })
})

describe('a coordinator given retention', () => {
  const POLL = 1_000
  const coordinator = (retention?: Worker.MaintenanceOptions['retention']) =>
    Worker.coordinator({
      registry: registry(programs),
      pollMs: POLL,
      ...(retention === undefined ? {} : { retention }),
    })

  it.effect('removes what ended longer ago than it keeps', () => {
    const { served, provide } = setup(programs)
    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          const old = yield* ended(served)
          const lost = yield* ended(served, failed('no'))
          yield* Effect.forkScoped(
            coordinator({ olderThan: '1h', statuses: ['completed'] }),
          )
          yield* idle

          yield* elapse(HOUR, 60_000)
          expect(yield* exists(old.root)).toBe(true)
          // The first sweep after the hour is over.
          yield* elapse(60_000, 60_000)
          expect(yield* exists(old.root)).toBe(false)
          expect(yield* exists(old.child)).toBe(false)
          expect(yield* exists(lost.root)).toBe(true)
        }),
      ),
    )
  })

  it.effect('sweeps as often as it is told, a batch at a time', () => {
    const { served, provide, inspect } = setup(programs)
    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          for (let made = 0; made < 3; made++) yield* ended(served)
          yield* Effect.forkScoped(
            coordinator({
              olderThan: '1m',
              everyMs: 10 * 60_000,
              batchSize: 1,
            }),
          )
          yield* idle

          yield* elapse(9 * 60_000, 60_000)
          expect(inspect.runs()).toHaveLength(6)
          yield* elapse(60_000, 60_000)
          expect(inspect.runs()).toEqual([])
        }),
      ),
    )
  })

  it.effect('removes nothing when it is given none', () => {
    const { served, provide } = setup(programs)
    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          const { root } = yield* ended(served)
          yield* Effect.forkScoped(coordinator())
          yield* idle
          yield* elapse(2 * HOUR, 60_000)
          expect(yield* exists(root)).toBe(true)
        }),
      ),
    )
  })

  it('refuses settings it cannot use, before it runs', () => {
    expect(() => coordinator({ olderThan: '1h', batchSize: -1 })).toThrow(
      RangeError,
    )
    expect(() => coordinator({ olderThan: 'long' as never })).toThrow(
      'Invalid retention olderThan duration [long]',
    )
    expect(() => coordinator({ olderThan: '1h', everyMs: 0 })).toThrow(
      'Worker retention everyMs must be positive',
    )
  })
})
