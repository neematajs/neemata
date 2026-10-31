import { describe, expect, it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'

import type { AnySchedule, InMemory } from '../../src/index.ts'
import { scheduleEntry } from '../../src/dsl/schedule.ts'
import { reconcile as reconcileEntries } from '../../src/engine.ts'
import {
  Client,
  DefinitionConflict,
  describeDefinition,
  schedule,
  start,
  Store,
  task,
  UnknownSchedule,
  Worker,
  workflow,
} from '../../src/index.ts'
import { graphKey, revisionKey } from '../../src/plan/definitions.ts'
import { elapse, idle } from '../support.ts'
import { deployment } from '../typed-support.ts'

const START = Date.parse('2026-01-01T00:00:02.500Z')
const POLL = 1_000

const Scenario = Schema.Struct({ scenario: Schema.String })
const io = { pool: 'jobs', input: Scenario, output: Schema.String } as const

/** A workflow of one activity that gives its scenario back. */
const report = (
  options: {
    readonly revision?: string
    readonly tags?: (input: { readonly scenario: string }) => {
      readonly scenario: string
    }
    /** What the activity adds: another graph when it is another step. */
    readonly step?: string
  } = {},
) => {
  const { step = 'write', ...rest } = options
  return workflow({ ...io, ...rest, name: 'report' }, function* (w) {
    return yield* w.activity(step, {
      input: Scenario,
      output: Schema.String,
      from: w.input,
      handler: ({ scenario }) =>
        Effect.succeed(`${scenario}@${options.revision}`),
    })
  })
}
const Report = report()

const Sweep = task({
  ...io,
  name: 'sweep',
  handler: ({ scenario }) => Effect.succeed(scenario),
})

const every = (name: string, options: Partial<AnySchedule> = {}) =>
  schedule({
    name,
    runnable: Report,
    input: { scenario: name },
    every: '10s',
    ...options,
  })

/** A store whose clock reads `START`, and what the tests ask of it. */
function setup(options?: InMemory.InMemoryOptions) {
  const made = deployment(options)
  const provide = <A, E>(effect: Effect.Effect<A, E, Store>) =>
    made.provide(Effect.andThen(TestClock.setTime(START), effect))
  return { ...made, provide }
}

/**
 * A store that runs `act` once between the next planned mutation and its
 * commit: what another scheduler, a client or a starting worker does while a
 * fire or a reconcile is under way.
 */
function gapped() {
  let pending: Effect.Effect<unknown> | undefined
  const made = setup({
    beforeCommit: () => {
      const act = pending
      pending = undefined
      if (act) Effect.runSync(act)
    },
  })
  const inGap = (act: Effect.Effect<unknown, unknown, Store>) =>
    // On the clock of the test, which a run of its own would not have.
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

const reconcile = Worker.reconcileSchedules
const list = Client.schedules.list()
const named = (name: string) =>
  Effect.map(list, (schedules) => schedules.find((s) => s.name === name)!)
const runsOf = (name: string) =>
  Effect.map(Client.list({ tags: { schedule: name } }), ({ runs }) => runs)

describe('a schedule declaration', () => {
  const base = { name: 's', runnable: Report, input: { scenario: 'a' } }

  it('is enabled unless it says otherwise', () => {
    expect(schedule({ ...base, every: '1s' })).toMatchObject({
      kind: 'schedule',
      enabled: true,
    })
    expect(schedule({ ...base, every: '1s', enabled: false }).enabled).toBe(
      false,
    )
  })

  it('names exactly one cadence', () => {
    expect(() => schedule(base)).toThrow(
      'Schedule [s] must define exactly one of cron/every',
    )
    expect(() => schedule({ ...base, every: '1s', cron: '* * * * *' })).toThrow(
      'Schedule [s] must define exactly one of cron/every',
    )
  })

  it('names a cadence that can be read', () => {
    expect(() => schedule({ ...base, every: 'soon' as never })).toThrow(
      'Invalid schedule [s] every duration [soon]',
    )
    expect(() => schedule({ ...base, every: '0s' })).toThrow(
      'Invalid schedule [s] every duration [0s]',
    )
    // An interval is kept in whole milliseconds, by every store.
    for (const every of ['1.5ms', '0.0001s'] as const) {
      expect(() => schedule({ ...base, every })).toThrow(
        `Schedule [s] every duration [${every}] is not a whole number of milliseconds`,
      )
    }
    expect(scheduleEntry(schedule({ ...base, every: '1.001s' }))).toMatchObject(
      { everyMs: 1001 },
    )
    expect(() => schedule({ ...base, cron: 'not cron' })).toThrow(
      'Invalid schedule [s] cron [not cron]',
    )
    expect(() =>
      schedule({ ...base, cron: '0 9 * * *', timeZone: 'Mars/Olympus' }),
    ).toThrow('Invalid schedule [s] timeZone [Mars/Olympus]')
    expect(() =>
      schedule({ ...base, every: '1h', timeZone: 'Europe/Paris' }),
    ).toThrow('Schedule [s] timeZone applies to cron only')
  })
})

describe('reconciling', () => {
  it.effect('adds, changes and removes to match what is declared', () => {
    const { provide } = setup()
    const alpha = every('alpha', { tags: { tenant: 'one' } })
    const beta = every('beta', { every: '30s' })
    const changed = every('alpha', {
      input: { scenario: 'changed' },
      every: undefined,
      cron: '*/5 * * * * *',
      timeZone: 'UTC',
      tags: { tenant: 'two' },
      enabled: false,
    })

    return provide(
      Effect.gen(function* () {
        const added = yield* reconcile([beta, alpha])
        expect(yield* list).toEqual([
          {
            name: 'alpha',
            runnable: { kind: 'workflow', name: 'report' },
            graphHash: describeDefinition(Report).graphHash,
            input: { scenario: 'alpha' },
            tags: { tenant: 'one' },
            everyMs: 10_000,
            enabled: true,
            nextRunAt: START + 10_000,
            version: 1,
            createdAt: START,
            updatedAt: START,
          },
          expect.objectContaining({ name: 'beta', everyMs: 30_000 }),
        ])
        expect(added.map(({ name }) => name)).toEqual(['beta', 'alpha'])

        yield* TestClock.adjust(1_000)
        yield* reconcile([changed])
        expect(yield* list).toEqual([
          expect.objectContaining({
            name: 'alpha',
            input: { scenario: 'changed' },
            tags: { tenant: 'two' },
            cron: '*/5 * * * * *',
            timeZone: 'UTC',
            enabled: false,
            version: 2,
            createdAt: START,
            updatedAt: START + 1_000,
          }),
        ])
        expect((yield* list)[0]).not.toHaveProperty('everyMs')

        yield* reconcile([])
        expect(yield* list).toEqual([])
      }),
    )
  })

  it.effect('refuses two schedules of one name before it writes', () => {
    const { provide } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('kept')])
        expect(() => reconcile([every('twice'), every('twice')])).toThrow(
          'Duplicate workflow schedule [twice]',
        )
        expect((yield* list).map(({ name }) => name)).toEqual(['kept'])
      }),
    )
  })

  it.effect('refuses an input the runnable cannot store', () => {
    const { provide } = setup()
    const invalid = every('invalid', { input: { scenario: 7 } as never })

    return provide(
      Effect.gen(function* () {
        let thrown: unknown
        try {
          reconcile([every('fine'), invalid])
        } catch (error) {
          thrown = error
        }
        expect(thrown).toMatchObject({
          message: 'Invalid schedule [invalid] input',
          cause: expect.any(Error),
        })
        expect(yield* list).toEqual([])
      }),
    )
  })

  it.effect('counts the first slot from the moment it is reconciled', () => {
    const { provide } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([
          every('every', { every: '5s' }),
          every('cron', {
            every: undefined,
            cron: '*/5 * * * * *',
            timeZone: 'UTC',
          }),
          every('now', { every: '1h', immediately: true }),
        ])
        expect((yield* named('every')).nextRunAt).toBe(START + 5_000)
        expect((yield* named('cron')).nextRunAt).toBe(
          Date.parse('2026-01-01T00:00:05.000Z'),
        )
        expect((yield* named('now')).nextRunAt).toBe(START)
      }),
    )
  })

  it.effect('reads a cron expression in the zone of the schedule', () => {
    const { provide } = setup()
    const nine = (name: string, timeZone?: string) =>
      every(name, {
        every: undefined,
        cron: '0 9 * * *',
        ...(timeZone === undefined ? {} : { timeZone }),
      })

    return provide(
      Effect.gen(function* () {
        yield* reconcile([
          nine('utc', 'UTC'),
          nine('new-york', 'America/New_York'),
          nine('here'),
        ])
        expect((yield* named('utc')).nextRunAt).toBe(
          Date.parse('2026-01-01T09:00:00Z'),
        )
        expect((yield* named('new-york')).nextRunAt).toBe(
          Date.parse('2026-01-01T14:00:00Z'),
        )
        // Stored, so every scheduler reads the expression alike.
        expect((yield* named('here')).timeZone).toBe(
          Intl.DateTimeFormat().resolvedOptions().timeZone,
        )

        // Another zone is another cadence: the slot is counted again.
        yield* reconcile([nine('utc', 'Asia/Tokyo')])
        expect((yield* named('utc')).nextRunAt).toBe(
          Date.parse('2026-01-02T00:00:00Z'),
        )
      }),
    )
  })

  it.effect(
    'gives a hashed expression one slot, whoever plans it and however often',
    () => {
      const hashed = every('nightly', {
        every: undefined,
        cron: 'H H * * *',
        timeZone: 'UTC',
      })
      /** The slot a scheduler with a store of its own comes to. */
      const planned = Effect.suspend(() =>
        setup().provide(
          Effect.andThen(
            reconcile([hashed]),
            Effect.map(named('nightly'), ({ nextRunAt }) => nextRunAt),
          ),
        ),
      )
      const { provide } = setup()

      return Effect.gen(function* () {
        const [slot, ...others] = yield* Effect.replicateEffect(planned, 5)
        expect(others).toStrictEqual([slot, slot, slot, slot])

        // And the slot after it is the same minute of the next day.
        yield* provide(
          Effect.gen(function* () {
            yield* reconcile([hashed])
            yield* TestClock.setTime(slot!)
            expect(yield* Worker.fireSchedules()).toStrictEqual({ fired: 1 })
            expect((yield* named('nightly')).nextRunAt).toBe(slot! + 86_400_000)
          }),
        )
      })
    },
  )

  it.effect('moves a slot only when the cadence does', () => {
    const { provide } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { every: '1h', immediately: true })])
        yield* TestClock.adjust(60_000)

        // The same again writes nothing, however often a worker starts.
        yield* reconcile([every('s', { every: '1h', immediately: true })])
        expect(yield* named('s')).toMatchObject({
          nextRunAt: START,
          version: 1,
          updatedAt: START,
        })

        // What it starts changed: the slot it was at stays.
        yield* reconcile([
          every('s', { every: '1h', input: { scenario: 'b' } }),
        ])
        expect(yield* named('s')).toMatchObject({
          input: { scenario: 'b' },
          nextRunAt: START,
          version: 2,
        })

        yield* reconcile([
          every('s', { every: '2h', input: { scenario: 'b' } }),
        ])
        expect((yield* named('s')).nextRunAt).toBe(START + 60_000 + 7_200_000)
      }),
    )
  })

  it.effect(
    'starts a schedule that is enabled again from its next slot',
    () => {
      const { provide } = setup()
      return provide(
        Effect.gen(function* () {
          yield* reconcile([every('s', { enabled: false })])
          yield* TestClock.adjust(5_000)
          // Its slot has not come: it keeps it.
          yield* reconcile([every('s')])
          expect((yield* named('s')).nextRunAt).toBe(START + 10_000)

          yield* reconcile([every('s', { enabled: false })])
          yield* TestClock.adjust(60_000)
          yield* reconcile([every('s')])
          expect((yield* named('s')).nextRunAt).toBe(START + 75_000)
          expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })
        }),
      )
    },
  )

  it.effect('leaves one declared set when two reconcile at once', () => {
    const { provide, inGap } = gapped()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('old')])
        yield* inGap(reconcile([every('right'), every('extra')]))
        yield* reconcile([every('left')])
        // The second saw what the first wrote, and removed it.
        expect((yield* list).map(({ name }) => name)).toEqual(['left'])
      }),
    )
  })

  it.effect('saves what a schedule pins, with the schedule', () => {
    const { provide, inspect } = setup()
    const v1 = report({ revision: 'v1' })

    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { runnable: v1 })])
        const { graphHash } = describeDefinition(v1)
        expect(yield* named('s')).toMatchObject({
          runnable: { kind: 'workflow', name: 'report', revision: 'v1' },
          graphHash,
        })
        expect(Array.from(inspect.definitions().keys())).toEqual(
          expect.arrayContaining([
            graphKey(graphHash),
            revisionKey({ kind: 'workflow', name: 'report', revision: 'v1' }),
          ]),
        )
      }),
    )
  })

  it.effect(
    'leaves every schedule as it was when one declaration conflicts',
    () => {
      const { provide } = setup()
      const v1 = report({ revision: 'v1' })
      // The same revision with another graph: edited in place.
      const edited = report({ revision: 'v1', step: 'rewrite' })

      return provide(
        Effect.gen(function* () {
          yield* reconcile([every('kept', { runnable: v1 })])
          const error = yield* Effect.flip(
            reconcile([every('new'), every('other', { runnable: edited })]),
          )
          expect(error).toBeInstanceOf(DefinitionConflict)
          expect((yield* list).map(({ name }) => name)).toEqual(['kept'])

          // Nor may two declarations disagree about a revision nobody saved.
          const fresh = { revision: 'v2' }
          expect(
            yield* Effect.flip(
              reconcile([
                every('a', { runnable: report(fresh) }),
                every('b', { runnable: report({ ...fresh, step: 'rewrite' }) }),
              ]),
            ),
          ).toBeInstanceOf(DefinitionConflict)
          expect((yield* list).map(({ name }) => name)).toEqual(['kept'])
        }),
      )
    },
  )
})

describe('firing', () => {
  it.effect(
    'fires a due slot once and moves past now, skipping what was missed',
    () => {
      const { provide, inspect } = setup()
      const declared = every('s', {
        every: '10ms',
        tags: { tenant: 't-1' },
        immediately: true,
      })

      return provide(
        Effect.gen(function* () {
          yield* reconcile([declared])
          expect(yield* Worker.fireSchedules()).toEqual({ fired: 1 })
          yield* TestClock.adjust(1_005)
          expect(yield* Worker.fireSchedules()).toEqual({ fired: 1 })
          expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })

          const [second, first] = yield* runsOf('s')
          expect(first).toMatchObject({
            kind: 'workflow',
            name: 'report',
            status: 'queued',
            input: { scenario: 's' },
            tags: { tenant: 't-1', schedule: 's' },
            idempotencyKey: ['$schedule', 's', START],
            graphHash: describeDefinition(Report).graphHash,
          })
          // The slot it was at, not the hundred that passed since.
          expect(second!.idempotencyKey).toEqual(['$schedule', 's', START + 10])
          expect(yield* named('s')).toMatchObject({
            lastSlotAt: START + 10,
            // Slots keep their phase, however late one is fired.
            nextRunAt: START + 1_010,
            version: 3,
          })
          // Each run came with what starts it.
          expect(inspect.queue().map(({ command }) => command)).toMatchObject([
            { kind: 'continueRun', runId: first!.id },
            { kind: 'continueRun', runId: second!.id },
          ])
        }),
      )
    },
  )

  it.effect('starts a task run with its first attempt', () => {
    const { provide, inspect } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { runnable: Sweep, immediately: true })])
        yield* Worker.fireSchedules()
        const [run] = yield* runsOf('s')
        expect(run).toMatchObject({ kind: 'task', name: 'sweep' })
        expect(inspect.queue().map(({ command }) => command)).toMatchObject([
          { kind: 'runTask', runId: run!.id, input: { scenario: 's' } },
        ])
      }),
    )
  })

  it.effect('tags runs as the runnable does when the schedule has none', () => {
    const { provide } = setup()
    const Tagged = report({ tags: ({ scenario }) => ({ scenario }) })

    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { runnable: Tagged, immediately: true })])
        yield* Worker.fireSchedules()
        expect((yield* runsOf('s'))[0]!.tags).toEqual({
          scenario: 's',
          schedule: 's',
        })
      }),
    )
  })

  it.effect(
    'stores the input encoded, and builds tags from the decoded one',
    () => {
      const { provide } = setup()
      const Counted = task({
        name: 'counted',
        pool: 'jobs',
        input: Schema.Struct({ count: Schema.NumberFromString }),
        output: Schema.Number,
        // What the stored text would not give: '21' + 1 is '211'.
        tags: ({ count }) => ({ next: String(count + 1) }),
        handler: ({ count }) => Effect.succeed(count),
      })

      return provide(
        Effect.gen(function* () {
          yield* reconcile([
            schedule({
              name: 's',
              runnable: Counted,
              input: { count: 21 },
              every: '1h',
              immediately: true,
            }),
          ])
          expect(yield* named('s')).toMatchObject({
            input: { count: '21' },
            tags: { next: '22' },
          })
          yield* Worker.fireSchedules()
          expect((yield* runsOf('s'))[0]).toMatchObject({
            input: { count: '21' },
            tags: { next: '22', schedule: 's' },
          })
        }),
      )
    },
  )

  it.effect('never fires a schedule that is not enabled', () => {
    const { provide } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { enabled: false, immediately: true })])
        yield* TestClock.adjust(60_000)
        expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })
        expect((yield* Client.list()).runs).toEqual([])
      }),
    )
  })

  it.effect('fires a slot once, however many schedulers find it due', () => {
    const { provide, inGap } = gapped()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { immediately: true })])
        // Another scheduler fires the slot while this one is committing.
        yield* inGap(Worker.fireSchedules())
        expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })
        expect(yield* runsOf('s')).toHaveLength(1)
        expect(yield* named('s')).toMatchObject({
          lastSlotAt: START,
          nextRunAt: START + 10_000,
          version: 2,
        })
      }),
    )
  })

  it.effect('keeps a schedule off that was turned off during a fire', () => {
    const { provide, inGap } = gapped()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { immediately: true })])
        yield* inGap(Client.schedules.setEnabled('s', false))
        expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })
        expect(yield* named('s')).toMatchObject({ enabled: false })
        expect(yield* runsOf('s')).toEqual([])
      }),
    )
  })

  it.effect('leaves a schedule removed that went during a fire', () => {
    const { provide, inGap } = gapped()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { immediately: true })])
        yield* inGap(reconcile([]))
        expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })
        expect(yield* list).toEqual([])
        expect((yield* Client.list()).runs).toEqual([])
      }),
    )
  })

  it.effect('pages through more due schedules than one read takes', () => {
    const { provide } = setup()
    const names = ['a', 'b', 'c', 'd', 'e']

    return provide(
      Effect.gen(function* () {
        yield* reconcile(
          names.map((name) => every(name, { immediately: true })),
        )
        expect(yield* Worker.fireSchedules({ batchSize: 2 })).toEqual({
          fired: 5,
        })
        expect((yield* Client.list()).runs).toHaveLength(5)
      }),
    )
  })

  it.effect(
    'pins each run to the revision and graph the schedule was reconciled with',
    () => {
      const { provide } = setup()
      const v1 = report({ revision: 'v1' })
      const v2 = report({ revision: 'v2', step: 'rewrite' })

      return provide(
        Effect.gen(function* () {
          yield* reconcile([
            every('s', { runnable: v1, every: '1h', immediately: true }),
          ])
          yield* Worker.fireSchedules()
          const slot = START + 3_600_000
          expect((yield* named('s')).nextRunAt).toBe(slot)

          // A new revision is for the slots still to come, at their times.
          yield* reconcile([
            every('s', {
              runnable: v2,
              every: '1h',
              input: { scenario: 'after' },
            }),
          ])
          expect((yield* named('s')).nextRunAt).toBe(slot)
          yield* TestClock.setTime(slot)
          yield* Worker.fireSchedules()
          const manual = yield* Client.schedules.trigger('s')

          const [, second, first] = yield* runsOf('s')
          expect(first).toMatchObject({
            revision: 'v1',
            graphHash: describeDefinition(v1).graphHash,
            input: { scenario: 's' },
          })
          expect(second).toMatchObject({
            revision: 'v2',
            graphHash: describeDefinition(v2).graphHash,
            input: { scenario: 'after' },
          })
          expect(manual).toMatchObject({ revision: 'v2' })
          // The graph a fire pins was saved by the reconcile.
          expect(yield* Client.inspect(second!.id)).toMatchObject({
            definition: {
              source: 'saved',
              revision: { revision: 'v2' },
              structure: { nodes: [{ name: 'rewrite' }] },
            },
          })
        }),
      )
    },
  )

  it.effect(
    'adopts the run of a slot that was started and never recorded',
    () => {
      const { provide } = setup()
      const v1 = report({ revision: 'v1' })
      const v2 = report({ revision: 'v2', step: 'rewrite' })

      return provide(
        Effect.gen(function* () {
          yield* reconcile([every('s', { runnable: v1, immediately: true })])
          // What a scheduler that crashed after creating the run left: the
          // slot's run, and the schedule still at the slot.
          const { run: orphan } = yield* start({
            name: 'report',
            revision: 'v1',
            definition: v1.program.definition,
            input: { scenario: 'before' },
            tags: { schedule: 's' },
            idempotencyKey: ['$schedule', 's', START],
          })
          // A deployment meanwhile changed what the schedule starts.
          yield* reconcile([
            every('s', { runnable: v2, input: { scenario: 'after' } }),
          ])
          expect((yield* named('s')).nextRunAt).toBe(START)

          expect(yield* Worker.fireSchedules()).toEqual({ fired: 1 })
          expect((yield* runsOf('s')).map(({ id }) => id)).toEqual([orphan.id])
          expect(yield* named('s')).toMatchObject({
            lastSlotAt: START,
            nextRunAt: START + 10_000,
          })

          // The slot after it is fired as the schedule is now.
          yield* TestClock.adjust(10_000)
          expect(yield* Worker.fireSchedules()).toEqual({ fired: 1 })
          expect((yield* runsOf('s'))[0]).toMatchObject({
            revision: 'v2',
            input: { scenario: 'after' },
          })
        }),
      )
    },
  )
})

describe('the client', () => {
  it.effect('lists schedules by name', () => {
    const { provide } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('b'), every('c'), every('a')])
        expect((yield* list).map(({ name }) => name)).toEqual(['a', 'b', 'c'])
      }),
    )
  })

  it.effect('triggers a run of its own each time, beside the slots', () => {
    const { provide } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s', { every: '1h', enabled: false })])
        const before = yield* named('s')

        const first = yield* Client.schedules.trigger('s')
        const second = yield* Client.schedules.trigger('s')
        expect(second.id).not.toBe(first.id)
        expect(first).toMatchObject({
          status: 'queued',
          input: { scenario: 's' },
          tags: { schedule: 's' },
        })
        // No slot's run, and nothing that a second trigger is to find.
        expect(first).not.toHaveProperty('idempotencyKey')
        expect((yield* runsOf('s')).map(({ id }) => id)).toEqual([
          second.id,
          first.id,
        ])
        // The schedule is as it was: off, and at the slot it was at.
        expect(yield* named('s')).toEqual(before)

        expect(yield* Effect.flip(Client.schedules.trigger('none'))).toEqual(
          new UnknownSchedule({ name: 'none' }),
        )
      }),
    )
  })

  it.effect('turns a schedule off, and on again from its next slot', () => {
    const { provide } = setup()
    return provide(
      Effect.gen(function* () {
        yield* reconcile([every('s')])
        expect(yield* Client.schedules.setEnabled('s', false)).toMatchObject({
          name: 's',
          enabled: false,
          nextRunAt: START + 10_000,
        })
        // Turned on before its slot came, it keeps the slot.
        expect(yield* Client.schedules.setEnabled('s', true)).toMatchObject({
          enabled: true,
          nextRunAt: START + 10_000,
        })

        yield* Client.schedules.setEnabled('s', false)
        yield* TestClock.adjust(35_000)
        expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })
        // What it missed while off is not fired.
        expect(yield* Client.schedules.setEnabled('s', true)).toMatchObject({
          enabled: true,
          nextRunAt: START + 40_000,
        })
        expect(yield* Worker.fireSchedules()).toEqual({ fired: 0 })

        const unknown = yield* Effect.flip(
          Client.schedules.setEnabled('none', true),
        )
        expect(unknown).toBeInstanceOf(UnknownSchedule)
        expect(unknown.message).toBe('Unknown workflow schedule [none]')
      }),
    )
  })
})

describe('a coordinator given schedules', () => {
  const coordinator = (options: Partial<Worker.MaintenanceOptions> = {}) =>
    Worker.coordinator({ workflows: [Report], pollMs: POLL, ...options })
  const execution = Worker.execution({ workflows: [Report], pollMs: POLL })

  it.effect(
    'reconciles them as it starts, then fires each slot and works its run',
    () => {
      const { provide } = setup()
      const hourly = every('hourly', { every: '1h', immediately: true })

      return provide(
        Effect.scoped(
          Effect.gen(function* () {
            yield* reconcile([every('stale')])
            // Two schedulers: a slot is still fired once.
            for (const worker of [
              coordinator({ schedules: [hourly] }),
              coordinator({ schedules: [hourly] }),
              execution,
            ]) {
              yield* Effect.forkScoped(worker)
            }
            yield* idle
            expect((yield* list).map(({ name }) => name)).toEqual(['hourly'])

            yield* elapse(5_000)
            expect(yield* runsOf('hourly')).toMatchObject([
              { status: 'completed', output: 'hourly@undefined' },
            ])
            yield* elapse(3_600_000, 60_000)
            yield* elapse(5_000)
            expect(
              (yield* runsOf('hourly')).map(({ idempotencyKey }) =>
                idempotencyKey?.at(-1),
              ),
            ).toEqual([START + 3_600_000, START])
          }),
        ),
      )
    },
  )

  it.effect('fires as often as `scheduling` says', () => {
    const { provide } = setup()
    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            coordinator({
              schedules: [every('s', { immediately: true })],
              scheduling: { everyMs: 60_000, batchSize: 1 },
            }),
          )
          yield* idle
          yield* elapse(59_000)
          expect(yield* runsOf('s')).toEqual([])
          yield* elapse(1_000)
          expect(yield* runsOf('s')).toHaveLength(1)
        }),
      ),
    )
  })

  it.effect('leaves schedules alone when it is given none', () => {
    const { provide } = setup()
    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          yield* reconcile([every('s', { immediately: true })])
          yield* Effect.forkScoped(coordinator())
          yield* idle
          yield* elapse(30_000)
          expect((yield* list).map(({ name }) => name)).toEqual(['s'])
          expect(yield* runsOf('s')).toEqual([])
        }),
      ),
    )
  })

  it.effect('fails as it starts when a declaration conflicts', () => {
    const { provide } = setup()
    const v1 = report({ revision: 'v1' })
    const edited = report({ revision: 'v1', step: 'rewrite' })

    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          yield* reconcile([every('s', { runnable: v1 })])
          const worker = yield* Effect.forkScoped(
            coordinator({ schedules: [every('s', { runnable: edited })] }),
          )
          expect(yield* Effect.flip(Fiber.join(worker))).toBeInstanceOf(
            DefinitionConflict,
          )
          expect((yield* named('s')).graphHash).toBe(
            describeDefinition(v1).graphHash,
          )
        }),
      ),
    )
  })

  it('refuses an interval that is no whole number of milliseconds, whoever gives it', () => {
    // Not a declaration: an entry as a caller of the engine makes one.
    const entry = { ...scheduleEntry(every('s')), everyMs: 1000.5 }
    expect(() => reconcileEntries([entry])).toThrow(
      'Schedule [s] everyMs [1000.5] must be a positive whole number of milliseconds',
    )
  })

  it('refuses options and declarations it cannot use, before it runs', () => {
    expect(() => coordinator({ schedules: [every('s'), every('s')] })).toThrow(
      'Duplicate workflow schedule [s]',
    )
    expect(() =>
      coordinator({
        schedules: [every('s', { input: { scenario: 1 } as never })],
      }),
    ).toThrow('Invalid schedule [s] input')
    expect(() =>
      coordinator({ schedules: [], scheduling: { everyMs: 0 } }),
    ).toThrow('Worker scheduling everyMs must be positive')
    expect(() =>
      coordinator({ schedules: [], scheduling: { batchSize: 1.5 } }),
    ).toThrow('Sweep batchSize must be a positive integer')
  })
})
