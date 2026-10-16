import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'

import type {
  AttemptInfo,
  Execute,
  Program,
  Registry,
  RetryPolicy,
  StopReason,
  TaskProgram,
  WorkflowProgram,
} from '../src/index.ts'
import {
  cancel,
  CleanupTimeout,
  registry,
  start,
  StorageError,
  Store,
  Worker,
} from '../src/index.ts'
import {
  claimAttempts,
  elapse,
  idle,
  LEASE,
  load,
  pass,
  setup,
} from './support.ts'

const POLL = 1_000
const BEAT = LEASE / 3

const task = (
  execute: Execute,
  limits: Pick<TaskProgram, 'retry' | 'timeout'> = {},
): TaskProgram => ({ kind: 'task', name: 'job', execute, ...limits })

/** One activity, whose output is the run's. */
const workflow = (
  execute: Execute,
  limits: { readonly retry?: RetryPolicy } = {},
): WorkflowProgram => ({
  kind: 'workflow',
  name: 'flow',
  steps: [
    {
      kind: 'activity',
      name: 'act',
      execute,
      input: (_outputs, input) => input,
      ...limits,
    },
  ],
  result: ({ act }) => act,
})

/** A handler that runs until it is interrupted, and says when and why. */
function endless() {
  const seen = {
    started: 0,
    interruptedAt: undefined as number | undefined,
    stopReason: undefined as StopReason | undefined,
  }
  const execute: Execute = (_input, attempt) =>
    Effect.suspend(() => {
      seen.started += 1
      return Effect.never
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          seen.interruptedAt = yield* Clock.currentTimeMillis
          seen.stopReason = yield* attempt.stopReason
        }),
      ),
    )
  return { seen, execute }
}

const options = { leaseMs: LEASE, pollMs: POLL }

const coordinator = (served: Registry) =>
  Effect.forkScoped(Worker.coordinator({ registry: served, ...options }))

const execution = (
  served: Registry,
  overrides: Partial<Worker.Options & Worker.ExecutionOptions> = {},
) =>
  Effect.forkScoped(
    Worker.execution({ registry: served, ...options, ...overrides }),
  )

const startTask = (input: unknown = null) =>
  start({ kind: 'task', name: 'job', input })
const startFlow = (input: unknown = null) => start({ name: 'flow', input })

describe('workers', () => {
  it.effect('run a workflow of activities and tasks to its result', () => {
    const programs: Program[] = [
      {
        kind: 'workflow',
        name: 'order',
        steps: [
          {
            kind: 'activity',
            name: 'price',
            execute: (input) => Effect.succeed((input as number) * 2),
            input: (_outputs, input) => input,
          },
          {
            kind: 'task',
            name: 'charge',
            task: { name: 'charge' },
            input: ({ price }) => price,
          },
          {
            kind: 'parallel',
            name: 'notify',
            members: {
              mail: {
                kind: 'activity',
                execute: (input) => Effect.succeed(`mail ${String(input)}`),
                input: ({ charge }) => charge,
              },
              text: {
                kind: 'task',
                task: { name: 'charge' },
                input: () => 1,
              },
            },
          },
        ],
        result: ({ notify }) => notify,
      },
      {
        kind: 'task',
        name: 'charge',
        execute: (input, { attemptNumber }) =>
          Effect.as(
            Effect.sleep(5_000),
            `charged ${String(input)} in ${attemptNumber}`,
          ),
      },
    ]
    const { served, provide, inspect } = setup(programs)

    return provide(
      Effect.gen(function* () {
        yield* coordinator(served)
        yield* execution(served, { concurrency: 2 })
        const { run } = yield* start({ name: 'order', input: 21 })

        yield* elapse(10_000)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: { mail: 'mail charged 42 in 1', text: 'charged 1 in 1' },
        })
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect('give handlers the services the worker was given', () => {
    class Mailer extends Context.Service<
      Mailer,
      { readonly send: (to: string) => Effect.Effect<string> }
    >()('test/Mailer') {}
    const { served, provide } = setup([
      task((input) =>
        Effect.flatMap(Mailer, (mailer) => mailer.send(input as string)),
      ),
    ])
    const worker = Worker.execution<Mailer>({ registry: served })
    expectTypeOf(worker).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store | Mailer>
    >()

    return provide(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Effect.provideService(worker, Mailer, {
            send: (to) => Effect.succeed(`sent to ${to}`),
          }),
        )
        const { run } = yield* startTask('ada')

        yield* idle
        expect((yield* load(run.id)).run.output).toBe('sent to ada')
      }),
    )
  })

  it.effect('refuse options no worker can run with', () =>
    Effect.sync(() => {
      const served = registry([])
      for (const invalid of [
        { concurrency: 0 },
        { concurrency: 1.5 },
        { leaseMs: 0 },
        { pollMs: Number.NaN },
      ]) {
        expect(() =>
          Worker.execution({ registry: served, ...invalid }),
        ).toThrow(/Worker (concurrency|leaseMs|pollMs) must be/)
        expect(() =>
          Worker.coordinator({ registry: served, ...invalid }),
        ).toThrow(/Worker (concurrency|leaseMs|pollMs) must be/)
      }
    }),
  )
})

describe('starting an attempt', () => {
  it.effect(
    'takes a delayed task run from queued to running when it is due, without a hint',
    () => {
      const startedAt: number[] = []
      const { served, provide } = setup([
        task(() =>
          Effect.gen(function* () {
            startedAt.push(yield* Clock.currentTimeMillis)
            yield* Effect.sleep(2_000)
            return 'done'
          }),
        ),
      ])

      return provide(
        Effect.gen(function* () {
          yield* execution(served)
          const { run } = yield* start({
            kind: 'task',
            name: 'job',
            input: null,
            startAt: 5_000,
          })

          yield* elapse(4_000)
          yield* TestClock.adjust(999)
          yield* idle
          expect(startedAt).toStrictEqual([])
          expect((yield* load(run.id)).run.status).toBe('queued')

          yield* TestClock.adjust(1)
          yield* idle
          expect(startedAt).toStrictEqual([5_000])
          expect((yield* load(run.id)).run.status).toBe('running')

          yield* elapse(2_000)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: 'done',
          })
        }),
      )
    },
  )

  it.effect(
    'runs no handler when the worker was told to stop while it began',
    () => {
      const { seen, execute } = endless()
      const { served, provide, inspect, store } = setup([task(execute)])
      // Beginning is a write, and a write takes a while.
      const slow = Store.of({
        ...store,
        transact: (scope, plan) =>
          Effect.andThen(Effect.sleep(100), store.transact(scope, plan)),
      })

      return provide(
        Effect.gen(function* () {
          const worker = yield* Effect.provideService(
            execution(served),
            Store,
            slow,
          )
          yield* startTask()
          yield* idle
          expect(inspect.queue()).toMatchObject([{ claim: {} }])

          const stopping = yield* Effect.forkScoped(Fiber.interrupt(worker))
          yield* elapse(100, 100)
          expect(stopping.pollUnsafe()).toBeDefined()
          // The work went back as it came: nothing of its handler ran.
          expect(seen.started).toBe(0)
          const [queued] = inspect.queue()
          expect(queued).not.toHaveProperty('claim')
          expect(queued).toMatchObject({ deliveries: 0 })
        }),
      )
    },
  )

  it.effect(
    'runs no handler for a delivery whose lease ended before it began',
    () => {
      const { seen, execute } = endless()
      const { served, provide, inspect, store } = setup([task(execute)])
      const other = registry([task(() => Effect.never)])
      // The first worker's begin is held up past the end of its lease.
      let held = false
      const paused = Store.of({
        ...store,
        transact: (scope, plan) => {
          if (held) return store.transact(scope, plan)
          held = true
          return Effect.andThen(
            Effect.sleep(LEASE + 2_000),
            store.transact(scope, plan),
          )
        },
      })

      return provide(
        Effect.gen(function* () {
          yield* Effect.provideService(execution(served), Store, paused)
          yield* startTask()
          yield* idle
          yield* execution(other)

          yield* elapse(LEASE + 2_000)
          // The other worker has the work: this one neither runs it beside
          // that one nor gives back a command that is not its own.
          expect(seen.started).toBe(0)
          expect(inspect.queue()).toMatchObject([{ deliveries: 2, claim: {} }])
        }),
      )
    },
  )

  it.effect(
    'tells a handler which work it does, alike at every attempt of it',
    () => {
      const told: AttemptInfo[] = []
      const execute: Execute = (_input, attempt) => {
        told.push(attempt)
        return attempt.attemptNumber < 2
          ? Effect.fail(new Error('again'))
          : Effect.succeed('done')
      }
      const member = { kind: 'activity', execute, retry: { attempts: 2 } }
      const { served, provide } = setup([
        {
          kind: 'workflow',
          name: 'flow',
          steps: [
            {
              kind: 'parallel',
              name: 'both',
              members: {
                left: { ...member, kind: 'activity', input: () => 'l' },
                right: { ...member, kind: 'activity', input: () => 'r' },
              },
            },
          ],
          result: ({ both }) => both,
        },
      ])
      const keys = (runId: string, childKey: string) =>
        told
          .filter((attempt) => attempt.runId === runId)
          .filter((attempt) => attempt.childKey === childKey)
          .map(({ idempotencyKey }) => idempotencyKey)

      return provide(
        Effect.gen(function* () {
          yield* coordinator(served)
          yield* execution(served, { concurrency: 4 })
          const { run } = yield* startFlow()
          const { run: other } = yield* startFlow()
          yield* idle

          expect((yield* load(run.id)).run.status).toBe('completed')
          const [left, retried, ...more] = keys(run.id, 'member:left')
          expect(retried).toBe(left)
          expect(more).toStrictEqual([])
          // No other work shares it: not its sibling's, not another run's.
          const [right] = keys(run.id, 'member:right')
          const [theirs] = keys(other.id, 'member:left')
          expect(new Set([left, right, theirs]).size).toBe(3)
        }),
      )
    },
  )

  it.effect('gives no stop reason to a handler that ended by itself', () => {
    const kept: AttemptInfo[] = []
    const { served, provide } = setup([
      task((_input, attempt) => {
        kept.push(attempt)
        // Ends while the race for it is under way.
        return Effect.as(Effect.sleep(1_000), 'done')
      }),
    ])

    return provide(
      Effect.gen(function* () {
        yield* execution(served)
        const { run } = yield* startTask()
        yield* elapse(1_000)
        expect((yield* load(run.id)).run.status).toBe('completed')
        expect(yield* kept[0]!.stopReason).toBeUndefined()
      }),
    )
  })

  it.effect('does not run the handler of a run that is being cancelled', () => {
    const { seen, execute } = endless()
    const { served, provide, inspect } = setup([workflow(execute)])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* startFlow()
        yield* pass(served)
        yield* cancel(run.id)

        // No coordinator: the run stays `cancelling`, its attempt `started`.
        yield* execution(served)
        yield* idle
        expect(seen.started).toBe(0)
        expect(
          inspect.queue().map(({ command }) => command.kind),
        ).toStrictEqual(['continueRun'])
      }),
    )
  })

  it.effect(
    'gives back an attempt no registered code runs, until it is set aside',
    () => {
      const { seen, execute } = endless()
      const { served, provide, inspect } = setup([workflow(execute)], {
        maxDeliveries: 2,
      })
      // Another build of the same workflow, without the step.
      const drifted = registry([{ ...workflow(execute), steps: [] }])

      return provide(
        Effect.gen(function* () {
          yield* startFlow()
          yield* pass(served)
          yield* execution(drifted)

          yield* idle
          expect(inspect.queue()).toMatchObject([
            {
              deliveries: 1,
              availableAt: 1_000,
              error: { message: expect.stringContaining('No registered code') },
            },
          ])

          // Delivered again after 1s, then after 2s more, and no further.
          yield* elapse(1_000)
          expect(inspect.queue()).toMatchObject([
            { deliveries: 2, availableAt: 3_000 },
          ])
          yield* elapse(2_000)
          expect(inspect.queue()).toStrictEqual([])
          expect(inspect.dead()).toMatchObject([
            { command: { kind: 'runAttempt' } },
          ])
          expect(seen.started).toBe(0)
        }),
      )
    },
  )
})

describe('an attempt that fails', () => {
  class Declined extends Data.TaggedError('Declined')<{
    readonly code: number
  }> {}

  it.effect.each([
    {
      how: 'a failure',
      execute: (() => Effect.fail(new Error('card declined'))) as Execute,
      error: { name: 'Error', message: 'card declined' },
    },
    {
      how: 'a defect',
      execute: (() => Effect.die(new TypeError('not a card'))) as Execute,
      error: { name: 'TypeError', message: 'not a card' },
    },
    {
      how: 'a handler that throws',
      execute: (() => {
        throw new Error('thrown')
      }) as Execute,
      error: { name: 'Error', message: 'thrown' },
    },
    {
      how: 'a tagged error, which has no message',
      execute: (() => Effect.fail(new Declined({ code: 51 }))) as Execute,
      error: { name: 'Declined', message: '{"code":51,"_tag":"Declined"}' },
    },
    {
      how: 'a failure that is not an error',
      execute: (() => Effect.fail({ reason: 'declined' })) as Execute,
      error: { message: '{"reason":"declined"}' },
    },
    {
      how: 'a failure that reads as an error, though it is none',
      execute: (() =>
        Effect.fail({
          name: 'GatewayError',
          message: 'declined',
          cause: { message: '503' },
        })) as Execute,
      error: {
        name: 'GatewayError',
        message: 'declined',
        cause: { message: '503' },
      },
    },
  ])('fails its run with what $how said', ({ execute, error }) => {
    const { served, provide } = setup([workflow(execute)])

    return provide(
      Effect.gen(function* () {
        yield* coordinator(served)
        yield* execution(served)
        const { run } = yield* startFlow()

        yield* idle
        const records = yield* load(run.id)
        expect(records.run).toMatchObject({ status: 'failed', error })
        expect(records.attempts).toMatchObject([{ status: 'failed', error }])
      }),
    )
  })

  it.effect('fails its run with all that a cause of several said', () => {
    const { served, provide } = setup([
      workflow(() =>
        Effect.fail(new Error('card declined')).pipe(
          Effect.ensuring(Effect.die(new Error('refund failed'))),
        ),
      ),
    ])

    return provide(
      Effect.gen(function* () {
        yield* coordinator(served)
        yield* execution(served)
        const { run } = yield* startFlow()

        yield* idle
        const { error } = (yield* load(run.id)).run
        expect(error?.name).toBe('WorkflowHandlerError')
        // Neither is picked over the other.
        expect(error?.message).toContain('card declined')
        expect(error?.message).toContain('refund failed')
      }),
    )
  })

  it.effect('is retried when its backoff has passed', () => {
    const ranAt: number[] = []
    const { served, provide } = setup([
      task(
        (_input, { attemptNumber }) =>
          Effect.flatMap(Clock.currentTimeMillis, (now) => {
            ranAt.push(now)
            return attemptNumber < 3
              ? Effect.fail(new Error(`failure ${attemptNumber}`))
              : Effect.succeed(attemptNumber)
          }),
        { retry: { attempts: 3, delay: '5s', backoff: 'exponential' } },
      ),
    ])

    return provide(
      Effect.gen(function* () {
        yield* execution(served)
        const { run } = yield* startTask()

        yield* elapse(20_000)
        expect(ranAt).toStrictEqual([0, 5_000, 15_000])
        const records = yield* load(run.id)
        expect(records.run).toMatchObject({ status: 'completed', output: 3 })
        expect(records.attempts.map(({ status }) => status)).toStrictEqual([
          'failed',
          'failed',
          'completed',
        ])
      }),
    )
  })

  it.effect(
    'times out after its limit, once its handler has cleaned up, and is retried',
    () => {
      const interruptedAt: number[] = []
      const { served, provide } = setup([
        task(
          (_input, { attemptNumber }) =>
            attemptNumber > 1
              ? Effect.succeed('second')
              : Effect.gen(function* () {
                  // Cleaning up takes time, in which the attempt still runs.
                  yield* Effect.addFinalizer(() => Effect.sleep(500))
                  return yield* Effect.never
                }).pipe(
                  Effect.onInterrupt(() =>
                    Effect.map(Clock.currentTimeMillis, (now) => {
                      interruptedAt.push(now)
                    }),
                  ),
                ),
          { timeout: '2s', retry: { attempts: 2 } },
        ),
      ])

      return provide(
        Effect.gen(function* () {
          yield* execution(served)
          const { run } = yield* startTask()

          yield* elapse(3_000, 500)
          expect(interruptedAt).toStrictEqual([2_000])
          const records = yield* load(run.id)
          expect(records.attempts).toMatchObject([
            {
              status: 'timedOut',
              completedAt: 2_500,
              error: { message: expect.stringContaining('timed out after 2s') },
            },
            { status: 'completed', output: 'second' },
          ])
          expect(records.run.status).toBe('completed')
        }),
      )
    },
  )

  it.effect(
    'is given back with the error when the engine fails on it, and worked again',
    () => {
      let fail = true
      let ran = 0
      const { served, provide, inspect } = setup(
        [
          task(() =>
            Effect.sync(() => {
              ran += 1
              return ran
            }),
          ),
        ],
        {
          beforeCommit: ({ attempts = [] }) => {
            if (fail && attempts.some(({ status }) => status === 'completed')) {
              fail = false
              throw new Error('disk full')
            }
          },
        },
      )

      return provide(
        Effect.gen(function* () {
          yield* execution(served)
          const { run } = yield* startTask()

          yield* idle
          expect(inspect.queue()).toMatchObject([
            { availableAt: 1_000, error: { message: 'disk full' } },
          ])
          expect((yield* load(run.id)).run.status).toBe('running')

          yield* elapse(1_000)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: 2,
          })
        }),
      )
    },
  )
})

describe('a heartbeat', () => {
  it.effect('keeps a handler that outlasts its lease from being redone', () => {
    let ran = 0
    const { served, provide } = setup([
      task(() =>
        Effect.suspend(() => {
          ran += 1
          return Effect.as(Effect.sleep(LEASE * 3), 'slow')
        }),
      ),
    ])

    return provide(
      Effect.gen(function* () {
        // The second worker would take the work the moment its lease ended.
        yield* execution(served)
        yield* execution(served)
        const { run } = yield* startTask()

        yield* elapse(LEASE * 3 - POLL)
        expect((yield* load(run.id)).run.status).toBe('running')
        yield* elapse(POLL)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'slow',
        })
        expect(ran).toBe(1)
      }),
    )
  })

  it.effect('survives a renewal the store could not make', () => {
    const { seen, execute } = endless()
    const { served, store } = setup([task(execute)])
    let renewals = 0
    const flaky = Store.of({
      ...store,
      renew: (claim, leaseMs) => {
        renewals += 1
        return renewals === 1
          ? Effect.fail(new StorageError({ cause: 'connection reset' }))
          : store.renew(claim, leaseMs)
      },
    })

    return Effect.provideService(
      Effect.gen(function* () {
        yield* execution(served)
        yield* execution(served)
        yield* startTask()

        // One beat missed, the next in time: still the first delivery.
        yield* elapse(LEASE * 2)
        expect(renewals).toBe(6)
        expect(seen).toStrictEqual({
          started: 1,
          interruptedAt: undefined,
          stopReason: undefined,
        })
      }),
      Store,
      flaky,
    )
  })

  /**
   * A worker whose first renewal is held up past the end of its lease, as by
   * a partition: another worker takes the work, and the renewal that at last
   * arrives finds the claim gone.
   */
  const partitioned = (store: Store['Service']) => {
    let held = false
    return Store.of({
      ...store,
      renew: (claim, leaseMs) => {
        if (held) return store.renew(claim, leaseMs)
        held = true
        return Effect.andThen(
          Effect.sleep(LEASE + 5_000 - BEAT),
          store.renew(claim, leaseMs),
        )
      },
    })
  }

  it.effect('interrupts the handler of a claim that was lost', () => {
    const { seen, execute } = endless()
    const { served, provide, store } = setup([task(execute)])
    const other = registry([task(() => Effect.succeed('theirs'))])

    return provide(
      Effect.gen(function* () {
        yield* Effect.provideService(
          execution(served),
          Store,
          partitioned(store),
        )
        const { run } = yield* startTask()
        yield* idle
        expect(seen.started).toBe(1)

        yield* execution(other)
        yield* elapse(LEASE)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'theirs',
        })
        expect(seen.interruptedAt).toBeUndefined()

        yield* elapse(5_000)
        expect(seen.interruptedAt).toBe(LEASE + 5_000)
        expect(seen.stopReason).toBe('claimLost')
      }),
    )
  })

  it.effect(
    'discards what a handler made of a claim that was lost meanwhile',
    () => {
      const { served, provide, store } = setup([
        task(() => Effect.as(Effect.sleep(LEASE + 2_000), 'mine')),
      ])
      const other = registry([
        task(() => Effect.as(Effect.sleep(10_000), 'theirs')),
      ])

      return provide(
        Effect.gen(function* () {
          yield* Effect.provideService(
            execution(served),
            Store,
            partitioned(store),
          )
          const { run } = yield* startTask()
          yield* idle
          yield* execution(other)

          // The first handler ends while the second, which holds the claim
          // by now, is still at work.
          yield* elapse(LEASE + 2_000)
          expect((yield* load(run.id)).attempts).toMatchObject([
            { status: 'started' },
          ])

          yield* elapse(8_000)
          const records = yield* load(run.id)
          expect(records.run.output).toBe('theirs')
          expect(records.attempts).toMatchObject([
            { status: 'completed', output: 'theirs' },
          ])
        }),
      )
    },
  )

  /** A store whose renewals take `ms` to come back. */
  const sluggish = (store: Store['Service'], ms: number) =>
    Store.of({
      ...store,
      renew: (claim, leaseMs) =>
        Effect.andThen(Effect.sleep(ms), store.renew(claim, leaseMs)),
    })

  it.effect('does not hold up a time limit that passes while it renews', () => {
    const { seen, execute } = endless()
    const { served, provide, store } = setup([
      task(execute, { timeout: '12s' }),
    ])

    return provide(
      Effect.gen(function* () {
        // The first renewal is under way from 10s to 15s.
        yield* Effect.provideService(
          execution(served),
          Store,
          sluggish(store, 5_000),
        )
        const { run } = yield* startTask()

        yield* elapse(12_000)
        expect(seen.interruptedAt).toBe(12_000)
        expect(seen.stopReason).toBe('timedOut')
        // The outcome is a write of its own, made once the renewal is.
        expect((yield* load(run.id)).attempts).toMatchObject([
          { status: 'started' },
        ])
        yield* elapse(3_000)
        expect((yield* load(run.id)).attempts).toMatchObject([
          { status: 'timedOut', completedAt: 15_000 },
        ])
      }),
    )
  })

  it.effect('does not hold up a worker that is stopped while it renews', () => {
    const { seen, execute } = endless()
    const { served, provide, store, inspect } = setup([task(execute)])

    return provide(
      Effect.gen(function* () {
        const worker = yield* Effect.provideService(
          execution(served),
          Store,
          sluggish(store, 5_000),
        )
        yield* startTask()
        yield* elapse(11_000)

        const stopping = yield* Effect.forkScoped(Fiber.interrupt(worker))
        yield* idle
        expect(seen.interruptedAt).toBe(11_000)
        expect(seen.stopReason).toBe('shutdown')
        // Given back only when the renewal has come back.
        expect(stopping.pollUnsafe()).toBeUndefined()
        expect(inspect.queue()).toMatchObject([{ claim: {} }])
        yield* elapse(4_000)
        expect(stopping.pollUnsafe()).toBeDefined()
        expect(inspect.queue()[0]).not.toHaveProperty('claim')
      }),
    )
  })

  it.effect(
    'interrupts the handler of a run that was cancelled, at its next beat',
    () => {
      const { seen, execute } = endless()
      const { served, provide, inspect, store } = setup([workflow(execute)])
      // A store that gives no hints: the heartbeat alone is the guarantee.
      const silent = Store.of({
        ...store,
        listen: () => Effect.succeed(Effect.never),
      })

      return provide(
        Effect.gen(function* () {
          yield* coordinator(served)
          yield* Effect.provideService(execution(served), Store, silent)
          const { run } = yield* startFlow()
          yield* idle
          expect(seen.started).toBe(1)

          yield* elapse(1_000)
          yield* cancel(run.id)
          yield* idle
          // The handler learns at its next beat; the run waits for it.
          expect((yield* load(run.id)).run.status).toBe('cancelling')
          expect(seen.interruptedAt).toBeUndefined()

          yield* elapse(BEAT - 1_000)
          expect(seen.interruptedAt).toBe(BEAT)
          expect(seen.stopReason).toBe('cancelled')
          yield* idle
          const ended = yield* load(run.id)
          expect(ended.run.status).toBe('cancelled')
          expect(ended.attempts).toMatchObject([{ status: 'cancelled' }])
          expect(inspect.queue()).toStrictEqual([])
        }),
      )
    },
  )

  it.effect.each([
    ['a workflow run', startFlow, [workflow]] as const,
    ['a task run', startTask, [task]] as const,
  ])(
    'is brought forward by the hint that %s was cancelled',
    ([, begin, [program]]) => {
      const { seen, execute } = endless()
      const { served, provide, inspect } = setup([program(execute)])

      return provide(
        Effect.gen(function* () {
          yield* coordinator(served)
          yield* execution(served)
          const { run } = yield* begin()
          yield* idle

          yield* elapse(1_000)
          yield* cancel(run.id)
          yield* idle
          // Long before the beat: the hint made the worker look at once.
          expect(seen.interruptedAt).toBe(1_000)
          expect(seen.stopReason).toBe('cancelled')
          expect((yield* load(run.id)).run.status).toBe('cancelled')
          expect(inspect.queue()).toStrictEqual([])
        }),
      )
    },
  )

  it.effect.each([
    ['a workflow run', 'flow', workflow] as const,
    ['a task run', 'job', task] as const,
  ])(
    'keeps %s cancelling, and its unique key held, while its handler cleans up',
    ([, name, program]) => {
      // Two seconds of cleanup once told to stop.
      const execute: Execute = () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sleep(2_000)))
      const { served, provide, inspect } = setup([program(execute)])
      const keyed = () =>
        start({
          ...(program === task ? { kind: 'task' as const } : {}),
          name,
          input: null,
          unique: { key: ['entity', 1] },
        })

      return provide(
        Effect.gen(function* () {
          yield* coordinator(served)
          yield* execution(served)
          const { run } = yield* keyed()
          yield* idle

          yield* cancel(run.id)
          yield* elapse(1_000)
          // Told at once, and still cleaning up: nothing else may hold the
          // key, as its work is not over.
          const ending = yield* load(run.id)
          expect(ending.run.status).toBe('cancelling')
          expect(ending.attempts).toMatchObject([{ status: 'started' }])
          expect((yield* Effect.flip(keyed()))._tag).toBe('RunConflict')

          yield* elapse(1_000)
          const ended = yield* load(run.id)
          expect(ended.run.status).toBe('cancelled')
          expect(ended.attempts).toMatchObject([{ status: 'cancelled' }])
          const { run: next } = yield* keyed()
          expect(next.id).not.toBe(run.id)
          yield* cancel(next.id)
          yield* elapse(2_000)
          expect(inspect.queue()).toStrictEqual([])
        }),
      )
    },
  )

  it.effect('takes a hint for no more than a reason to look', () => {
    const { seen, execute } = endless()
    const { served, provide, store } = setup([workflow(execute)])

    return provide(
      Effect.gen(function* () {
        yield* execution(served)
        const { run } = yield* startFlow()
        yield* pass(served)
        yield* idle
        expect(seen.started).toBe(1)

        // Groundless: nothing asked the run to stop.
        yield* store.transact({}, () => ({
          _tag: 'Commit',
          mutation: { notify: [`stop:${run.id}`] },
          result: undefined,
        }))
        yield* idle
        expect(seen.interruptedAt).toBeUndefined()
        yield* elapse(LEASE)
        expect(seen.interruptedAt).toBeUndefined()
      }),
    )
  })
})

describe('waiting for work', () => {
  const quick = [workflow((input) => Effect.succeed(input))]
  const slowly = { ...options, pollMs: 60_000 }

  it.effect('ends early on a hint, however long the poll interval', () => {
    const { served, provide } = setup(quick)

    return provide(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Worker.coordinator({ registry: served, ...slowly }),
        )
        yield* Effect.forkScoped(
          Worker.execution({ registry: served, ...slowly }),
        )
        yield* idle
        const { run } = yield* startFlow('now')

        yield* idle
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'now',
        })
        expect(yield* Clock.currentTimeMillis).toBe(0)
      }),
    )
  })

  it.effect('takes at once what a stopping worker gives back', () => {
    const { execute } = endless()
    const { served, provide } = setup([task(execute)])
    const next = registry([task(() => Effect.succeed('finished'))])

    return provide(
      Effect.gen(function* () {
        const worker = yield* Effect.forkScoped(
          Worker.execution({ registry: served, ...slowly }),
        )
        const { run } = yield* startTask()
        yield* idle
        yield* Effect.forkScoped(
          Worker.execution({ registry: next, ...slowly }),
        )
        yield* idle
        expect((yield* load(run.id)).run.status).toBe('running')

        yield* Fiber.interrupt(worker)
        yield* idle
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'finished',
        })
        expect(yield* Clock.currentTimeMillis).toBe(0)
      }),
    )
  })

  it.effect('finds everything by polling when no hint ever comes', () => {
    const { served, store } = setup(quick)
    const silent = Store.of({
      ...store,
      hints: () => Effect.succeed(Effect.never),
    })

    return Effect.provideService(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Worker.coordinator({ registry: served, ...slowly }),
        )
        yield* Effect.forkScoped(
          Worker.execution({ registry: served, ...slowly }),
        )
        yield* idle
        const { run } = yield* startFlow('later')

        yield* idle
        expect((yield* load(run.id)).run.status).toBe('queued')

        // A poll each to open the step, run it and read its outcome.
        yield* elapse(180_000, 60_000)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'completed',
          output: 'later',
        })
      }),
      Store,
      silent,
    )
  })
})

describe('concurrency', () => {
  it.effect('fills its limit and never exceeds it', () => {
    let active = 0
    const seen: number[] = []
    const { served, provide } = setup([
      task(() =>
        Effect.gen(function* () {
          active += 1
          seen.push(active)
          yield* Effect.sleep(1_000)
          active -= 1
        }),
      ),
    ])

    return provide(
      Effect.gen(function* () {
        const runs = yield* Effect.all(
          Array.from({ length: 5 }, (_, index) => startTask(index)),
        )
        yield* execution(served, { concurrency: 2 })

        yield* idle
        expect(active).toBe(2)
        yield* elapse(3_000)
        // Each handler that ends makes room for exactly one more.
        expect(seen).toStrictEqual([1, 2, 2, 2, 2])
        for (const { run } of runs) {
          expect((yield* load(run.id)).run.status).toBe('completed')
        }
      }),
    )
  })

  it.effect('takes tasks and activities in the order they were queued', () => {
    const order: string[] = []
    const record =
      (kind: string): Execute =>
      () =>
        Effect.andThen(
          Effect.sync(() => order.push(kind)),
          Effect.sleep(1_000),
        )
    const { served, provide } = setup([
      workflow(record('activity')),
      task(record('task')),
    ])

    return provide(
      Effect.gen(function* () {
        yield* startFlow()
        yield* pass(served)
        yield* startTask()
        yield* Effect.all([startFlow(), startFlow()])
        yield* pass(served)

        // One at a time, so the order of the claims is the order of the work:
        // the oldest command first, of whichever kind it is.
        yield* execution(served)
        yield* elapse(4_000)
        expect(order).toStrictEqual([
          'activity',
          'task',
          'activity',
          'activity',
        ])
      }),
    )
  })
})

describe('a worker that stops', () => {
  it.effect(
    'interrupts its handlers and gives their work to the next worker',
    () => {
      const { seen, execute } = endless()
      const { served, provide, inspect } = setup([task(execute)])
      const next = registry([task(() => Effect.succeed('finished'))])

      return provide(
        Effect.gen(function* () {
          const worker = yield* execution(served)
          const { run } = yield* startTask()
          yield* idle
          expect(seen.started).toBe(1)
          expect(inspect.queue()).toMatchObject([{ claim: {} }])

          // Interrupting returns when the worker has given everything back.
          yield* Fiber.interrupt(worker)
          expect(seen.interruptedAt).toBe(0)
          expect(seen.stopReason).toBe('shutdown')
          const [queued] = inspect.queue()
          expect(queued).not.toHaveProperty('claim')
          expect(queued).not.toHaveProperty('error')
          expect((yield* load(run.id)).attempts).toMatchObject([
            { status: 'started' },
          ])

          yield* execution(next)
          yield* idle
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: 'finished',
          })
          expect(yield* Clock.currentTimeMillis).toBe(0)
        }),
      )
    },
  )

  it.effect('does not start a handler it was stopped while preparing', () => {
    const { seen, execute } = endless()
    const { served, provide, inspect, store } = setup([task(execute)])
    let open: () => void = () => {}
    // Subscribing waits: the worker is stopped after the work has begun and
    // before its handler would start.
    const gated = Store.of({
      ...store,
      listen: (topic) =>
        Effect.andThen(
          Effect.callback<void>((resume) => {
            open = () => resume(Effect.void)
          }),
          store.listen(topic),
        ),
    })

    return provide(
      Effect.gen(function* () {
        const worker = yield* Effect.provideService(
          execution(served),
          Store,
          gated,
        )
        yield* startTask()
        yield* idle
        const stopping = yield* Effect.forkScoped(Fiber.interrupt(worker))
        yield* idle
        open()
        yield* Fiber.join(stopping)

        expect(seen.started).toBe(0)
        expect(inspect.queue()[0]).not.toHaveProperty('claim')
      }),
    )
  })

  it.effect(
    'lets its handlers finish when the store fails it, then fails itself',
    () => {
      let down = false
      const { served, provide, store } = setup([
        task(() => Effect.as(Effect.sleep(5_000), 'kept')),
      ])
      const failing = Store.of({
        ...store,
        claim: (request) =>
          down
            ? Effect.fail(new StorageError({ cause: 'store down' }))
            : store.claim(request),
      })

      return provide(
        Effect.gen(function* () {
          const worker = yield* Effect.provideService(
            execution(served, { concurrency: 2 }),
            Store,
            failing,
          )
          const { run } = yield* startTask()
          yield* idle
          down = true

          yield* elapse(4_000)
          expect(worker.pollUnsafe()).toBeUndefined()
          yield* elapse(1_000)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: 'kept',
          })
          expect(yield* Effect.flip(Fiber.join(worker))).toEqual(
            new StorageError({ cause: 'store down' }),
          )
        }),
      )
    },
  )
})

describe('a handler that does not yield to interruption', () => {
  /** Runs for `ms` whatever is asked of it, and says when it ended. */
  function stubborn(ms?: number) {
    const seen = { endedAt: undefined as number | undefined }
    const execute: Execute = () =>
      Effect.uninterruptible(
        (ms === undefined ? Effect.never : Effect.sleep(ms)).pipe(
          Effect.andThen(Clock.currentTimeMillis),
          Effect.map((now) => {
            seen.endedAt = now
            return 'too late'
          }),
        ),
      )
    return { seen, execute }
  }

  it.effect(
    'is given up on when its time limit passed: the worker fails, and gives the rest back',
    () => {
      const { execute } = stubborn()
      const sibling = endless()
      const { served, provide, inspect } = setup([
        task(execute, { timeout: '1s' }),
        workflow(sibling.execute),
      ])

      return provide(
        Effect.gen(function* () {
          const { run: flowRun } = yield* startFlow()
          yield* pass(served)
          const { run } = yield* startTask()
          const worker = yield* execution(served, {
            concurrency: 2,
            cleanupTimeoutMs: 2_000,
          })
          yield* idle
          expect(sibling.seen.started).toBe(1)

          // Told to stop after a second, it is waited for two more.
          yield* elapse(2_900, 100)
          expect(worker.pollUnsafe()).toBeUndefined()
          yield* elapse(100, 100)
          const failure = yield* Effect.flip(Fiber.join(worker))
          expect(failure).toStrictEqual(
            new CleanupTimeout({ timeoutMs: 2_000 }),
          )
          expect(failure.message).toBe(
            'Workflow cleanup exceeded 2000ms; worker recycling required',
          )

          // The work that could be stopped went back for another worker.
          expect(sibling.seen.interruptedAt).toBe(3_000)
          const queue = inspect.queue()
          const of = (runId: string) =>
            queue.find(({ command }) => command.runId === runId)!
          expect(of(flowRun.id)).not.toHaveProperty('claim')
          expect(of(flowRun.id).deliveries).toBe(0)
          // The handler may still be going: its attempt has no outcome, and
          // its command is not delivered again before its lease ends.
          expect(of(run.id)).toMatchObject({ claim: { expiresAt: LEASE } })
          expect((yield* load(run.id)).attempts).toMatchObject([
            { status: 'started' },
          ])
          expect(yield* claimAttempts(served)).toMatchObject([
            { command: { runId: flowRun.id } },
          ])
          yield* elapse(LEASE - 3_000)
          expect(yield* claimAttempts(served)).toMatchObject([
            { command: { runId: run.id }, deliveries: 2 },
          ])
        }),
      )
    },
  )

  it.effect(
    'has no outcome but the timeout when it ends within the wait',
    () => {
      const { seen, execute } = stubborn(1_500)
      const { served, provide, inspect } = setup([
        task(execute, { timeout: '1s' }),
      ])

      return provide(
        Effect.gen(function* () {
          const worker = yield* execution(served, { cleanupTimeoutMs: 2_000 })
          const { run } = yield* startTask()
          yield* idle

          yield* elapse(1_400, 100)
          // Timed out, and not settled while the handler is still ending.
          expect((yield* load(run.id)).run.status).toBe('running')
          yield* elapse(100, 100)
          expect(seen.endedAt).toBe(1_500)
          // It came to a success, after the engine had stopped waiting for
          // one: the attempt timed out.
          const { run: ended, attempts } = yield* load(run.id)
          expect(ended).toMatchObject({
            status: 'failed',
            error: { name: 'AttemptTimeout' },
          })
          expect(ended.output).toBeUndefined()
          expect(attempts).toMatchObject([
            { status: 'timedOut', completedAt: 1_500 },
          ])
          expect(inspect.queue()).toStrictEqual([])
          expect(worker.pollUnsafe()).toBeUndefined()
        }),
      )
    },
  )

  it.effect(
    'is given no longer to end by a renewal that is under way when it is told',
    () => {
      // Ends at 14s: two seconds after its limit, one after the wait.
      const { seen, execute } = stubborn(14_000)
      const { served, provide, store } = setup([
        task(execute, { timeout: '12s' }),
      ])
      // The first renewal is under way from 10s to 15s.
      const sluggish = Store.of({
        ...store,
        renew: (claim, leaseMs) =>
          Effect.andThen(Effect.sleep(5_000), store.renew(claim, leaseMs)),
      })

      return provide(
        Effect.gen(function* () {
          const worker = yield* Effect.provideService(
            execution(served, { cleanupTimeoutMs: 1_000 }),
            Store,
            sluggish,
          )
          const { run } = yield* startTask()

          yield* elapse(15_000)
          expect(seen.endedAt).toBe(14_000)
          // Told at 12s and waited for until 13s, whenever the renewal
          // came back: it overran, and the worker says so.
          expect(yield* Effect.flip(Fiber.join(worker))).toStrictEqual(
            new CleanupTimeout({ timeoutMs: 1_000 }),
          )
          expect((yield* load(run.id)).attempts).toMatchObject([
            { status: 'started' },
          ])
        }),
      )
    },
  )

  it.effect('does not keep a stopping worker from stopping', () => {
    const { execute } = stubborn()
    const { served, provide, inspect } = setup([task(execute)])

    return provide(
      Effect.gen(function* () {
        // Five seconds, when the worker is not told how long to wait.
        const worker = yield* execution(served)
        const { run } = yield* startTask()
        yield* idle

        const stopping = yield* Effect.forkScoped(Fiber.interrupt(worker))
        yield* elapse(4_900, 100)
        expect(stopping.pollUnsafe()).toBeUndefined()
        yield* elapse(100, 100)
        expect(stopping.pollUnsafe()).toBeDefined()

        // Stopped, and not cleanly: the worker says what it left running,
        // so whoever stopped it does not take its services from under it.
        const ended = yield* Fiber.await(worker)
        expect(
          Exit.isFailure(ended) &&
            ended.cause.reasons.flatMap((reason) =>
              Cause.isFailReason(reason) ? [reason.error] : [],
            ),
        ).toStrictEqual([new CleanupTimeout({ timeoutMs: 5_000 })])

        // Not given back: another worker would run it beside this handler.
        expect(inspect.queue()).toMatchObject([{ claim: {} }])
        expect((yield* load(run.id)).attempts).toMatchObject([
          { status: 'started' },
        ])
      }),
    )
  })

  it.effect(
    'keeps a run cancelling, and its key held, until its lease ends',
    () => {
      const { execute } = stubborn()
      const { served, provide } = setup([task(execute)])
      const keyed = () =>
        start({
          kind: 'task',
          name: 'job',
          input: null,
          unique: { key: ['stubborn'] },
        })

      return provide(
        Effect.gen(function* () {
          const worker = yield* execution(served, { cleanupTimeoutMs: 1_000 })
          const { run } = yield* keyed()
          yield* idle

          yield* cancel(run.id)
          yield* elapse(900, 100)
          expect(worker.pollUnsafe()).toBeUndefined()
          yield* elapse(100, 100)
          expect(yield* Effect.flip(Fiber.join(worker))).toStrictEqual(
            new CleanupTimeout({ timeoutMs: 1_000 }),
          )
          // Left behind, it may still be running while its claim lasts.
          expect((yield* load(run.id)).run.status).toBe('cancelling')
          expect((yield* Effect.flip(keyed()))._tag).toBe('RunConflict')

          // Its lease over, nothing of the run is held: the sweep ends it.
          yield* elapse(30_000)
          expect(yield* Worker.drainCancellations()).toEqual({ drained: 1 })
          expect((yield* load(run.id)).run.status).toBe('cancelled')
          const { run: next } = yield* keyed()
          expect(next.id).not.toBe(run.id)
        }),
      )
    },
  )

  it.effect('refuses a wait no worker can keep', () =>
    Effect.sync(() => {
      const served = registry([])
      for (const cleanupTimeoutMs of [-1, Infinity, Number.NaN]) {
        expect(() =>
          Worker.execution({ registry: served, cleanupTimeoutMs }),
        ).toThrow(
          'Worker cleanupTimeoutMs must be a finite non-negative number',
        )
      }
    }),
  )
})

describe('a coordinator', () => {
  it.effect(
    'gives back a run no registered workflow advances, until it is set aside',
    () => {
      const { served, provide, store, inspect } = setup(
        [workflow((input) => Effect.succeed(input))],
        { maxDeliveries: 1 },
      )

      return provide(
        Effect.gen(function* () {
          // A run of another workflow, queued under a route that is served.
          const { run } = yield* start({ name: 'elsewhere', input: null })
          yield* store.transact({}, () => ({
            _tag: 'Commit',
            result: undefined,
            mutation: {
              enqueue: [
                {
                  command: { kind: 'continueRun', name: 'flow', runId: run.id },
                  dedupe: 'misrouted',
                },
              ],
            },
          }))
          yield* coordinator(served)

          yield* idle
          expect(inspect.queue()).toMatchObject([
            { command: { name: 'elsewhere' } },
            {
              command: { name: 'flow' },
              availableAt: 1_000,
              error: {
                message: expect.stringContaining('No registered workflow'),
              },
            },
          ])

          yield* elapse(1_000)
          expect(inspect.dead()).toMatchObject([{ command: { name: 'flow' } }])
          expect((yield* load(run.id)).run.status).toBe('queued')
        }),
      )
    },
  )
})
