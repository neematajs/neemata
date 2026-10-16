import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import type {
  Command,
  Program,
  Registry,
  RetryPolicy,
  WorkflowProgram,
} from '../src/index.ts'
import {
  cancel,
  Client,
  InMemory,
  reap as reapOne,
  retry,
  settle,
  start,
  Store,
  Worker,
} from '../src/index.ts'
import * as support from './support.ts'
import {
  claimAttempts,
  completed,
  elapse,
  LEASE,
  load,
  pass,
  unused,
  work,
} from './support.ts'

const activity = (name: string, retry?: RetryPolicy) =>
  ({
    kind: 'activity',
    name,
    execute: unused,
    input: (_outputs: unknown, input: unknown) => input,
    ...(retry === undefined ? {} : { retry }),
  }) as const

/** One activity, with a budget a last failure does not get to use. */
const flow: WorkflowProgram = {
  kind: 'workflow',
  name: 'flow',
  steps: [activity('act', { attempts: 3 })],
  result: ({ act }) => act,
}

/** Two activities side by side. */
const pair: WorkflowProgram = {
  kind: 'workflow',
  name: 'pair',
  steps: [
    {
      kind: 'parallel',
      name: 'both',
      members: {
        left: { ...activity('left'), input: () => 'l' },
        right: { ...activity('right'), input: () => 'r' },
      },
    },
  ],
  result: ({ both }) => both,
}

const job: Program = { kind: 'task', name: 'job', execute: unused }

/** A parent of one task and one child workflow, started together. */
const parent = (cancellation?: 'detach'): WorkflowProgram => ({
  kind: 'workflow',
  name: 'parent',
  steps: [
    {
      kind: 'parallel',
      name: 'fan',
      members: {
        job: { kind: 'task', task: { name: 'job' }, input: () => 1 },
        flow: {
          kind: 'workflow',
          workflow: { name: 'flow' },
          input: () => 2,
          ...(cancellation === undefined ? {} : { cancellation }),
        },
      },
    },
  ],
  result: ({ fan }) => fan,
})

/** Every command dies on its second claim. */
const setup = (programs: readonly Program[], maxDeliveries = 1) =>
  support.setup(programs, { maxDeliveries })

const lanes = (served: Registry, kinds: readonly Command['kind'][]) =>
  kinds.map((kind) => ({
    kind,
    routes: kind === 'runTask' ? served.tasks : served.workflows,
  }))

/**
 * Delivers the due commands of the kinds until they are set aside, each
 * delivery failing with `error`, or with nothing but an ended lease.
 */
const kill = Effect.fnUntraced(function* (
  served: Registry,
  kinds: readonly Command['kind'][],
  error?: Error,
) {
  const store = yield* Store
  const claim = store.claim({
    lanes: lanes(served, kinds),
    limit: 100,
    leaseMs: 1_000,
  })
  for (;;) {
    const claims = yield* claim
    if (claims.length === 0) return
    if (error)
      for (const taken of claims) yield* store.release(taken, { error })
    else yield* TestClock.adjust(1_000)
  }
})

const reap = Worker.reapDeadCommands()

describe('counting deliveries', () => {
  it.effect('never sets aside a command that workers only gave back', () => {
    const { served, provide, store, inspect } = setup([flow], 2)

    return provide(
      Effect.gen(function* () {
        yield* start({ name: 'flow', input: 1 })
        yield* pass(served)

        // Worker after worker takes it and stops before it is done.
        for (let restarts = 0; restarts < 10; restarts++) {
          const [claim] = yield* claimAttempts(served)
          expect(claim).toMatchObject({ deliveries: 1 })
          yield* store.release(claim!)
        }
        expect(inspect.dead()).toStrictEqual([])

        // A delivery that failed counts, and so does one whose lease ended.
        const [failing] = yield* claimAttempts(served)
        yield* store.release(failing!, { error: new Error('broken') })
        expect(yield* claimAttempts(served, 1_000)).toMatchObject([
          { deliveries: 2 },
        ])
        yield* TestClock.adjust(1_000)
        expect(yield* claimAttempts(served)).toStrictEqual([])
        expect(inspect.dead()).toMatchObject([
          { deliveries: 2, error: { message: 'broken' } },
        ])
      }),
    )
  })
})

describe('the reaper', () => {
  it.effect(
    'fails the work of a dead attempt with its last error, without a retry',
    () => {
      const { served, provide, inspect } = setup([flow])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'flow', input: 1 })
          yield* pass(served)
          yield* kill(served, ['runAttempt'], new TypeError('no handler'))
          expect((yield* load(run.id)).run.status).toBe('running')

          expect(yield* reap).toStrictEqual({ reaped: 1 })
          const error = { name: 'TypeError', message: 'no handler' }
          const failing = yield* load(run.id)
          // The budget of three is not the reaper's to spend: a command
          // nobody is given any more would only die again.
          expect(failing.attempts).toMatchObject([{ status: 'failed', error }])
          expect(failing.children).toMatchObject([{ status: 'failed', error }])
          expect(failing.nodes).toMatchObject([{ status: 'failed', error }])

          // The run's own pass ends it, as after any failed attempt.
          expect(yield* pass(served)).toBe(1)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'failed',
            error,
          })
          expect(inspect.queue()).toStrictEqual([])
          // Nothing is left to do for it.
          expect(yield* reap).toStrictEqual({ reaped: 0 })
        }),
      )
    },
  )

  it.effect('says so when the command only ever lost its lease', () => {
    const { served, provide, inspect } = setup([job])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
        yield* kill(served, ['runTask'])
        const [dead] = inspect.dead()

        yield* reap
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'failed',
          error: {
            message: `Workflow command [${dead!.id}] was set aside after 1 deliveries`,
          },
        })
      }),
    )
  })

  it.effect(
    'ends a task run of a dead attempt and lets its parent read that',
    () => {
      const { served, provide } = setup([parent(), flow, job])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'parent', input: null })
          yield* pass(served)
          yield* kill(served, ['runTask'], new Error('task is gone'))

          expect(yield* reap).toStrictEqual({ reaped: 1 })
          const { children } = yield* load(run.id)
          const taskRunId = children.find(
            ({ childKey }) => childKey === 'member:job',
          )!.childRunId!
          expect((yield* load(taskRunId)).run).toMatchObject({
            status: 'failed',
            error: { message: 'task is gone' },
          })

          // The sibling is not stopped by a failure: the parent waits for it.
          yield* pass(served)
          expect((yield* load(run.id)).run.status).toBe('waiting')
          yield* work(served, completed('done'))
          yield* pass(served)
          yield* pass(served)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'failed',
            error: { message: 'task is gone' },
          })
        }),
      )
    },
  )

  it.effect.each([
    // Told to stop, and stopping while its activity's handler holds a claim.
    ['cancels a child run', undefined, 'cancelling'] as const,
    ['leaves a detached child run to itself', 'detach', 'running'] as const,
  ])(
    'fails the run of a dead continuation, and %s',
    ([, cancellation, childStatus]) => {
      const { served, provide } = setup([parent(cancellation), flow, job])
      const drifted = new Error('changed under its revision')

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'parent', input: null })
          yield* pass(served)
          // The child workflow's first pass, which starts its activity.
          yield* pass(served)
          const before = yield* load(run.id)
          const ids = Object.fromEntries(
            before.children.map(({ childKey, childRunId }) => [
              childKey,
              childRunId!,
            ]),
          )

          // The task ends, and the wake it sends the parent dies.
          const [task] = yield* claimAttempts(served)
          yield* settle(served, task!, completed('ok'))
          yield* kill(served, ['continueRun'], drifted)

          expect(yield* reap).toStrictEqual({ reaped: 1 })
          const failed = yield* load(run.id)
          expect(failed.run).toMatchObject({
            status: 'failed',
            error: { message: 'changed under its revision' },
          })
          // What it had in flight is cancelled, not failed.
          expect(failed.nodes).toMatchObject([{ status: 'cancelled' }])
          expect((yield* load(ids['member:job']!)).run.status).toBe('completed')

          yield* pass(served)
          expect((yield* load(ids['member:flow']!)).run.status).toBe(
            childStatus,
          )
        }),
      )
    },
  )

  it.effect(
    'fails one member of a fan-out and leaves the others to settle',
    () => {
      const { served, provide, store } = setup([pair])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'pair', input: null })
          yield* pass(served)
          const [left, right] = yield* claimAttempts(served)
          yield* store.release(left!, { error: new Error('left broke') })
          // Claimed again, the left attempt is set aside; the right is held.
          yield* claimAttempts(served)

          expect(yield* reap).toStrictEqual({ reaped: 1 })
          yield* pass(served)
          const waiting = yield* load(run.id)
          expect(waiting.run.status).toBe('running')
          expect(waiting.nodes).toMatchObject([{ status: 'running' }])

          yield* settle(served, right!, completed('r done'))
          yield* pass(served)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'failed',
            error: { message: 'left broke' },
          })
        }),
      )
    },
  )

  it.effect('leaves alone what no longer waits for the command', () => {
    const { served, provide, inspect } = setup([flow, job])

    return provide(
      Effect.gen(function* () {
        const cancelled = yield* start({ name: 'flow', input: 1 })
        const ended = yield* start({ kind: 'task', name: 'job', input: 1 })
        yield* pass(served)
        yield* kill(served, ['runAttempt', 'runTask'], new Error('dead'))

        // One run is asked to stop, and waits for the attempt its dead
        // command was for: no handler holds it, so reaping ends it. The
        // other run has ended since, with nothing claimed to wait for.
        yield* cancel(cancelled.run.id)
        yield* cancel(ended.run.id)
        expect(inspect.dead()).toHaveLength(2)
        expect(yield* reap).toStrictEqual({ reaped: 1 })

        yield* pass(served)
        for (const { run } of [cancelled, ended]) {
          const records = yield* load(run.id)
          expect(records.run).toMatchObject({ status: 'cancelled' })
          expect(records.run.error).toBeUndefined()
          expect(records.attempts).toMatchObject([{ status: 'cancelled' }])
        }
      }),
    )
  })

  it.effect('leaves alone a run that was retried since', () => {
    const { served, provide, inspect } = setup([flow])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* pass(served)
        yield* kill(served, ['runAttempt'], new Error('first'))
        yield* reap
        yield* pass(served)

        // The dead command names the attempt that failed; the retry made
        // another, which is not its to fail.
        yield* retry(run.id)
        yield* pass(served)
        expect(inspect.dead()).toHaveLength(1)
        expect(yield* reap).toStrictEqual({ reaped: 0 })

        yield* work(served, completed('second'))
        yield* pass(served)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'second',
        })
      }),
    )
  })

  it.effect('forgets a dead continuation once its run is woken again', () => {
    const { served, provide, inspect } = setup([flow])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* kill(served, ['continueRun'], new Error('drifted'))
        yield* reap
        expect((yield* load(run.id)).run.status).toBe('failed')
        expect(inspect.dead()).toHaveLength(1)

        // Retried, the run is active again with a wake of its own: were
        // the dead one still counted, the next sweep would fail the run.
        yield* retry(run.id)
        expect(inspect.dead()).toStrictEqual([])
        expect(yield* reap).toStrictEqual({ reaped: 0 })
        yield* pass(served)
        expect((yield* load(run.id)).run.status).toBe('running')
      }),
    )
  })

  it.effect('leaves alone a run retried since the command was listed', () => {
    const { served, provide, store } = setup([flow])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* kill(served, ['continueRun'], new Error('drifted'))
        // One reaper lists the command, and another gets to it first.
        const [listed] = (yield* store.dead({ active: true, limit: 1 })).items
        yield* reap
        yield* retry(run.id)

        // What the first one holds is dead no longer: the retry's wake
        // stands for the run now.
        expect(yield* reapOne(listed!)).toBe(false)
        expect((yield* load(run.id)).run).toMatchObject({ status: 'queued' })
        expect((yield* load(run.id)).run.error).toBeUndefined()
      }),
    )
  })

  it.effect(
    'acts on the dead command as it is stored, and only on the one it was told of',
    () => {
      const { served, provide, store } = setup([flow])

      return provide(
        Effect.gen(function* () {
          const first = yield* start({ name: 'flow', input: 1 })
          const second = yield* start({ name: 'flow', input: 2 })
          yield* kill(served, ['continueRun'], new Error('drifted'))
          const [one, other] = (yield* store.dead({ active: true, limit: 2 }))
            .items

          // A store that numbers its commands gives an id again once it is
          // set back to an earlier state: what a reaper listed under the id
          // was a command of another run than the one that is dead under it.
          expect(yield* reapOne({ ...other!, id: one!.id })).toBe(false)
          for (const { run } of [first, second]) {
            const stored = (yield* load(run.id)).run
            expect(stored.status).toBe('queued')
            expect(stored.error).toBeUndefined()
          }

          // The error is the stored command's too, whatever the listing said.
          expect(
            yield* reapOne({ ...one!, error: { message: 'as listed' } }),
          ).toBe(true)
          expect((yield* load(first.run.id)).run).toMatchObject({
            status: 'failed',
            error: { message: 'drifted' },
          })
        }),
      )
    },
  )

  it.effect('gets through more dead commands than one read takes', () => {
    const { served, provide } = setup([job])

    return provide(
      Effect.gen(function* () {
        const runs = yield* Effect.all(
          [1, 2, 3, 4, 5].map((input) =>
            start({ kind: 'task', name: 'job', input }),
          ),
        )
        yield* kill(served, ['runTask'], new Error('dead'))

        expect(yield* Worker.reapDeadCommands({ batchSize: 2 })).toStrictEqual({
          reaped: 5,
        })
        for (const { run } of runs) {
          expect((yield* load(run.id)).run.status).toBe('failed')
        }
      }),
    )
  })

  it.effect('refuses a batch size no sweep can use', () =>
    Effect.gen(function* () {
      const memory = InMemory.makeInMemoryStore()
      const exit = yield* Effect.exit(
        Effect.provideService(
          Worker.reapDeadCommands({ batchSize: 0 }),
          Store,
          memory.store,
        ),
      )
      expect(String(exit)).toContain(
        'Sweep batchSize must be a positive integer',
      )
    }),
  )
})

describe('a coordinator', () => {
  const coordinator = (
    served: Registry,
    options: Worker.MaintenanceOptions = {},
  ) =>
    Effect.forkScoped(
      Worker.coordinator({
        registry: served,
        leaseMs: LEASE,
        pollMs: 1_000,
        ...options,
      }),
    )

  it.effect('reaps every 30 seconds unless told otherwise', () => {
    const { served, provide } = setup([job])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
        yield* kill(served, ['runTask'], new Error('dead'))
        yield* coordinator(served)

        yield* elapse(29_000)
        expect((yield* load(run.id)).run.status).toBe('queued')
        yield* elapse(1_000)
        expect((yield* load(run.id)).run.status).toBe('failed')
      }),
    )
  })

  it.effect.each([
    ['as often as it is told to', { everyMs: 5_000 }, 'failed'] as const,
    ['not at all when reaping is off', false, 'queued'] as const,
  ])('reaps %s', ([, reaping, status]) => {
    const { served, provide } = setup([job])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
        yield* kill(served, ['runTask'], new Error('dead'))
        yield* coordinator(served, { reaping })

        yield* elapse(4_000)
        expect((yield* load(run.id)).run.status).toBe('queued')
        yield* elapse(1_000)
        expect((yield* load(run.id)).run.status).toBe(status)
        yield* elapse(60_000)
        expect((yield* load(run.id)).run.status).toBe(status)
      }),
    )
  })

  it.effect('refuses sweep options no sweep can run with', () =>
    Effect.sync(() => {
      const served = support.setup([job]).served
      const options = { registry: served }
      expect(() =>
        Worker.coordinator({ ...options, reaping: { everyMs: 0 } }),
      ).toThrow('Worker reaping everyMs must be positive')
      expect(() =>
        Worker.coordinator({ ...options, runTimeouts: { everyMs: -1 } }),
      ).toThrow('Worker runTimeouts everyMs must be positive')
      expect(() =>
        Worker.coordinator({ ...options, runTimeouts: { batchSize: 1.5 } }),
      ).toThrow('Sweep batchSize must be a positive integer')
    }),
  )

  it.effect('keeps sweeping after a sweep that failed', () => {
    const { served, provide, store } = setup([job])
    let failures = 1
    const flaky = Store.of({
      ...store,
      dead: (query) =>
        failures-- > 0
          ? Effect.die(new Error('store down'))
          : store.dead(query),
    })

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ kind: 'task', name: 'job', input: 1 })
        yield* kill(served, ['runTask'], new Error('dead'))
        yield* Effect.provideService(
          coordinator(served, { reaping: { everyMs: 5_000 } }),
          Store,
          flaky,
        )

        yield* elapse(5_000)
        expect((yield* load(run.id)).run.status).toBe('queued')
        yield* elapse(5_000)
        expect((yield* load(run.id)).run.status).toBe('failed')
      }),
    )
  })
})

describe('dead commands', () => {
  it.effect(
    'are listed, the earliest set aside first, a page at a time',
    () => {
      const { served, provide } = setup([flow, job])

      return provide(
        Effect.gen(function* () {
          const first = yield* start({ kind: 'task', name: 'job', input: 1 })
          yield* kill(served, ['runTask'], new Error('one'))
          yield* TestClock.adjust(5_000)
          const second = yield* start({ name: 'flow', input: 2 })
          yield* kill(served, ['continueRun'], new Error('two'))
          const third = yield* start({ kind: 'task', name: 'job', input: 3 })
          yield* kill(served, ['runTask'])

          const all = yield* Client.listDeadCommands()
          expect(all).toStrictEqual({
            commands: [
              {
                id: expect.any(String),
                command: expect.objectContaining({
                  kind: 'runTask',
                  runId: first.run.id,
                  nodeName: '$task',
                }),
                deliveries: 1,
                error: expect.objectContaining({ message: 'one' }),
                createdAt: 0,
                deadAt: 0,
              },
              {
                id: expect.any(String),
                command: {
                  kind: 'continueRun',
                  runId: second.run.id,
                  name: 'flow',
                },
                deliveries: 1,
                error: expect.objectContaining({ message: 'two' }),
                createdAt: 5_000,
                deadAt: 5_000,
              },
              {
                id: expect.any(String),
                command: expect.objectContaining({ runId: third.run.id }),
                deliveries: 1,
                createdAt: 5_000,
                deadAt: 6_000,
              },
            ],
          })

          expect(
            yield* Client.listDeadCommands({ runId: second.run.id }),
          ).toStrictEqual({ commands: [all.commands[1]] })

          const page = yield* Client.listDeadCommands({ limit: 2 })
          expect(page.commands).toStrictEqual(all.commands.slice(0, 2))
          expect(
            yield* Client.listDeadCommands({
              limit: 2,
              cursor: page.nextCursor!,
            }),
          ).toStrictEqual({ commands: [all.commands[2]] })
        }),
      )
    },
  )

  it.effect('are queued again as new, and are dead no longer', () => {
    const { served, provide, inspect } = setup([flow])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* pass(served)
        yield* kill(served, ['runAttempt'], new Error('deploy missing'))
        const [dead] = (yield* Client.listDeadCommands()).commands

        expect(yield* Client.requeueDeadCommand(dead!.id)).toBe(true)
        expect(yield* Client.listDeadCommands()).toStrictEqual({
          commands: [],
        })
        // Nothing is left for the reaper: the work has a command again.
        expect(yield* reap).toStrictEqual({ reaped: 0 })
        expect(inspect.queue()).toMatchObject([
          { command: dead!.command, deliveries: 0 },
        ])
        expect(yield* Client.requeueDeadCommand(dead!.id)).toBe(false)
        expect(inspect.queue()).toHaveLength(1)

        yield* work(served, completed('late'))
        yield* pass(served)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'late',
        })
      }),
    )
  })

  it.effect(
    'are queued again once, by whichever of two callers comes first',
    () => {
      let gap: Effect.Effect<unknown, unknown, Store> | undefined
      const { served, provide, inspect, store } = support.setup([flow], {
        maxDeliveries: 1,
        beforeCommit: () => {
          const act = gap
          gap = undefined
          if (act) Effect.runSync(Effect.provideService(act, Store, store))
        },
      })

      return provide(
        Effect.gen(function* () {
          yield* start({ name: 'flow', input: 1 })
          yield* pass(served)
          yield* kill(served, ['runAttempt'], new Error('deploy missing'))
          const [dead] = (yield* Client.listDeadCommands()).commands

          // Both found the command dead. Before this one commits, the other
          // queues it and a worker takes it: a claimed command keeps no other
          // from being added, so a second would be worked beside the first.
          gap = Effect.andThen(
            Client.requeueDeadCommand(dead!.id),
            claimAttempts(served),
          )
          expect(yield* Client.requeueDeadCommand(dead!.id)).toBe(false)
          expect(inspect.queue()).toMatchObject([
            { command: dead!.command, claim: {} },
          ])
          expect(inspect.queue()).toHaveLength(1)
        }),
      )
    },
  )

  it.effect('answer false for an id that names none', () => {
    const { provide, inspect } = setup([flow])

    return provide(
      Effect.gen(function* () {
        expect(yield* Client.requeueDeadCommand('command-404')).toBe(false)
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })
})
