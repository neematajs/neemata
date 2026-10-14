import { describe, expect, it } from '@effect/vitest'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'

import type {
  DurationString,
  Execute,
  Program,
  Registry,
  WorkflowProgram,
} from '../src/index.ts'
import {
  cancel,
  Client,
  registry,
  retry,
  settle,
  start,
  timeout,
  Worker,
  workflow,
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
  work,
} from './support.ts'
import { deployment } from './typed-support.ts'

const MINUTE = 60_000

/** One activity under a limit of five minutes for the whole run. */
const flow = (
  options: {
    readonly revision?: string
    readonly timeout?: DurationString
    readonly execute?: Execute
  } = {},
): WorkflowProgram => ({
  kind: 'workflow',
  name: 'flow',
  ...(options.revision === undefined ? {} : { revision: options.revision }),
  timeout: options.timeout ?? '5m',
  steps: [
    {
      kind: 'activity',
      name: 'act',
      execute: options.execute ?? unused,
      input: (_outputs, input) => input,
    },
  ],
  result: ({ act }) => act,
})

const job: Program = {
  kind: 'task',
  name: 'job',
  execute: unused,
  // Limits each attempt, never the run.
  timeout: '1m',
}

/** A parent without a limit of its own over a task and a limited child. */
const parent = (cancellation?: 'detach'): WorkflowProgram => ({
  kind: 'workflow',
  name: 'parent',
  timeout: '10m',
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

const sweep = (served: Registry) => Worker.timeoutRuns(served)

const timedOut = (runId: string, limit = '5m') => ({
  name: 'RunTimeout',
  message: `Workflow run [${runId}] timed out after [${limit}]`,
})

describe('a run past its timeout', () => {
  it.effect('is failed, and what it had in flight is cancelled', () => {
    const { served, provide, inspect } = setup([flow()])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* pass(served)

        // Not a moment before the limit has passed.
        yield* TestClock.adjust(5 * MINUTE)
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 0 })
        expect((yield* load(run.id)).run.status).toBe('running')

        yield* TestClock.adjust(1)
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 1 })
        const ended = yield* load(run.id)
        expect(ended.run).toMatchObject({
          status: 'failed',
          error: timedOut(run.id),
        })
        expect(ended.nodes).toMatchObject([{ status: 'cancelled' }])
        expect(ended.children).toMatchObject([{ status: 'cancelled' }])
        expect(ended.attempts).toMatchObject([
          { status: 'cancelled', completedAt: 5 * MINUTE + 1 },
        ])

        // The attempt's command is dropped by whoever takes it next.
        const [claim] = yield* claimAttempts(served)
        expect(yield* Client.get(run.id)).toStrictEqual(ended)
        expect(claim).toBeDefined()
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 0 })
        expect(inspect.dead()).toStrictEqual([])
      }),
    )
  })

  it.effect('is not given more time by the progress it makes', () => {
    const two: WorkflowProgram = {
      ...flow(),
      steps: [
        ...flow().steps,
        { ...flow().steps[0]!, name: 'more' } as WorkflowProgram['steps'][0],
      ],
    }
    const { served, provide } = setup([two])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* pass(served)
        yield* TestClock.adjust(4 * MINUTE)
        yield* work(served, completed('one'))
        yield* pass(served)
        const advanced = yield* load(run.id)
        expect(advanced.nodes).toMatchObject([
          { name: 'act', status: 'completed' },
          { name: 'more', status: 'running', createdAt: 4 * MINUTE },
        ])
        expect(advanced.run.activeSince).toBe(0)

        yield* TestClock.adjust(MINUTE + 1)
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 1 })
      }),
    )
  })

  it.effect('is failed whatever it was doing, but being cancelled', () => {
    const { served, provide } = setup([flow()])
    const program = served.workflow({ name: 'flow' })!

    return provide(
      Effect.gen(function* () {
        const done = yield* start({ name: 'flow', input: 1 })
        yield* pass(served)
        yield* work(served, completed('done'))
        yield* pass(served)
        // Neither of these is ever given a pass.
        const queued = yield* start({ name: 'flow', input: 2 })
        const cancelling = yield* start({ name: 'flow', input: 3 })
        yield* cancel(cancelling.run.id)
        yield* TestClock.adjust(5 * MINUTE + 1)

        expect(yield* sweep(served)).toStrictEqual({ timedOut: 1 })
        expect((yield* load(queued.run.id)).run).toMatchObject({
          status: 'failed',
          error: timedOut(queued.run.id),
        })
        expect((yield* load(done.run.id)).run.status).toBe('completed')

        // A cancellation asked for first stays one, however long the run
        // takes to end: not even a timeout asked for by name fails it.
        expect(yield* timeout(program, cancelling.run.id)).toBe(false)
        yield* pass(served)
        const cancelled = (yield* load(cancelling.run.id)).run
        expect(cancelled.status).toBe('cancelled')
        expect(cancelled.error).toBeUndefined()
      }),
    )
  })

  it.effect.each([
    ['cancels the runs it started', undefined, 'cancelled'] as const,
    ['leaves a detached child to itself', 'detach', 'running'] as const,
  ])('%s, and tells its own parent', ([, cancellation, childStatus]) => {
    const { served, provide } = setup([
      parent(cancellation),
      flow({ timeout: '1h' }),
      job,
    ])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'parent', input: null })
        yield* pass(served)
        yield* pass(served)
        const ids = Object.fromEntries(
          (yield* load(run.id)).children.map(({ childKey, childRunId }) => [
            childKey,
            childRunId!,
          ]),
        )
        yield* TestClock.adjust(10 * MINUTE + 1)

        // The task run is older than its own `timeout`, which limits an
        // attempt and is the worker's to enforce: only the parent is overdue.
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 1 })
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'failed',
          error: timedOut(run.id, '10m'),
        })
        // A task run has no pass to be cancelled in, so it is at once.
        expect((yield* load(ids['member:job']!)).run.status).toBe('cancelled')
        yield* pass(served)
        expect((yield* load(ids['member:flow']!)).run.status).toBe(childStatus)
      }),
    )
  })

  it.effect('fails its parent with the timeout it ended with', () => {
    const { served, provide } = setup([parent(), flow(), job])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'parent', input: null })
        yield* pass(served)
        yield* pass(served)
        const [task] = yield* claimAttempts(served)
        yield* settle(served, task!, completed('ok'))
        yield* TestClock.adjust(5 * MINUTE + 1)

        // The child's limit is the shorter one.
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 1 })
        const childRunId = (yield* load(run.id)).children.find(
          ({ childKey }) => childKey === 'member:flow',
        )!.childRunId!
        yield* pass(served)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'failed',
          error: timedOut(childRunId),
        })
      }),
    )
  })

  it.effect('is found however many are overdue at once', () => {
    const { served, provide } = setup([flow()])

    return provide(
      Effect.gen(function* () {
        const runs = yield* Effect.all(
          [1, 2, 3, 4, 5].map((input) => start({ name: 'flow', input })),
        )
        yield* TestClock.adjust(5 * MINUTE + 1)
        const late = yield* start({ name: 'flow', input: 6 })

        expect(
          yield* Worker.timeoutRuns(served, { batchSize: 2 }),
        ).toStrictEqual({ timedOut: 5 })
        for (const { run } of runs) {
          expect((yield* load(run.id)).run.status).toBe('failed')
        }
        expect((yield* load(late.run.id)).run.status).toBe('queued')
      }),
    )
  })

  it.effect('has its clock set back by a manual retry', () => {
    const { served, provide } = setup([flow()])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* pass(served)
        yield* TestClock.adjust(4 * MINUTE)
        yield* work(served, failed('broke'))
        yield* pass(served)
        expect((yield* load(run.id)).run.status).toBe('failed')

        yield* TestClock.adjust(4 * MINUTE)
        expect(yield* retry(run.id)).toMatchObject({
          status: 'queued',
          activeSince: 8 * MINUTE,
          createdAt: 0,
        })
        yield* pass(served)

        // Eight minutes old, and four minutes into its second life.
        yield* TestClock.adjust(MINUTE)
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 0 })
        yield* TestClock.adjust(4 * MINUTE + 1)
        expect(yield* sweep(served)).toStrictEqual({ timedOut: 1 })
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'failed',
          error: timedOut(run.id),
        })
      }),
    )
  })

  it.effect('is decided again in the commit that fails it', () => {
    const { served, provide } = setup([flow()])
    const [program] = [served.workflow({ name: 'flow' })!]

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* pass(served)
        // A candidate the sweep found is not overdue just for being found.
        expect(yield* timeout(program, run.id)).toBe(false)
        expect(yield* timeout(program, 'run-404')).toBe(false)

        yield* TestClock.adjust(5 * MINUTE + 1)
        yield* work(served, completed('in time to settle'))
        yield* pass(served)
        // Overdue when it was found, ended by the time it is its turn.
        expect(yield* timeout(program, run.id)).toBe(false)
        expect((yield* load(run.id)).run.status).toBe('completed')
      }),
    )
  })
})

describe('a run whose code no worker holds', () => {
  it.effect('is not timed out by the limit of another revision', () => {
    const programs = [
      flow({ timeout: '1m' }),
      flow({ revision: 'v2', timeout: '1m' }),
    ]
    const { provide } = setup(programs)

    return provide(
      Effect.gen(function* () {
        const unversioned = yield* start({ name: 'flow', input: 1 })
        const v1 = yield* start({ name: 'flow', revision: 'v1', input: 1 })
        const v2 = yield* start({ name: 'flow', revision: 'v2', input: 1 })
        yield* TestClock.adjust(MINUTE + 1)

        // A worker of v2 alone: the others wait for their own.
        const onlyV2 = registry([programs[1]!])
        expect(yield* Worker.timeoutRuns(onlyV2)).toStrictEqual({ timedOut: 1 })
        expect((yield* load(v2.run.id)).run.status).toBe('failed')
        expect((yield* load(v1.run.id)).run.status).toBe('queued')
        expect((yield* load(unversioned.run.id)).run.status).toBe('queued')

        // The unversioned lane is a lane of its own, never a wildcard.
        const onlyUnversioned = registry([programs[0]!])
        expect(yield* Worker.timeoutRuns(onlyUnversioned)).toStrictEqual({
          timedOut: 1,
        })
        expect((yield* load(v1.run.id)).run.status).toBe('queued')
        // Even asked for by name, a run is failed by its own program only.
        expect(yield* timeout(programs[1]!, v1.run.id)).toBe(false)
      }),
    )
  })

  it.effect(
    'is not timed out by a definition changed under its revision',
    () => {
      const declare = (steps: readonly string[]) =>
        workflow(
          {
            name: 'pinned',
            revision: 'v1',
            pool: 'test',
            timeout: '1m',
            input: Schema.String,
            output: Schema.String,
          },
          function* (w) {
            for (const step of steps) {
              yield* w.activity(step, {
                input: Schema.String,
                output: Schema.String,
                from: w.input,
                handler: (input) => Effect.succeed(input),
              })
            }
            return w.input
          },
        )
      const original = declare(['one'])
      const edited = declare(['one', 'two'])
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(original, 'x')
          yield* TestClock.adjust(MINUTE + 1)

          // The edited code has no say over the run, its timeout included.
          expect(
            yield* Worker.timeoutRuns(registry([edited.program])),
          ).toStrictEqual({ timedOut: 0 })
          expect((yield* load(run.id)).run.status).toBe('queued')
          expect(
            yield* Worker.timeoutRuns(registry([original.program])),
          ).toStrictEqual({ timedOut: 1 })
        }),
      )
    },
  )
})

describe('workers', () => {
  const options = { leaseMs: LEASE, pollMs: 1_000 }

  it.effect('time runs out every minute, and stop their handlers', () => {
    const seen = { interruptedAt: undefined as number | undefined }
    const execute: Execute = () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            seen.interruptedAt = now
          }),
        ),
      )
    const { served, provide, inspect } = setup([flow({ execute })])

    return provide(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Worker.coordinator({ registry: served, ...options }),
        )
        yield* Effect.forkScoped(
          Worker.execution({ registry: served, ...options }),
        )
        const { run } = yield* start({ name: 'flow', input: 1 })
        yield* idle

        // Overdue from just after the fifth minute; the sweep is on the sixth.
        yield* elapse(6 * MINUTE - 1_000, 1_000)
        expect((yield* load(run.id)).run.status).toBe('running')
        yield* elapse(1_000)
        expect((yield* load(run.id)).run).toMatchObject({
          status: 'failed',
          error: timedOut(run.id),
        })
        // Told at once, not at the next heartbeat.
        expect(seen.interruptedAt).toBe(6 * MINUTE)
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect.each([
    ['as often as they are told to', { everyMs: 10_000 }, 'failed'] as const,
    ['not at all when that is off', false, 'running'] as const,
  ])('time runs out %s', ([, runTimeouts, status]) => {
    const { served, provide } = setup([flow({ timeout: '1s' })])

    return provide(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          Worker.coordinator({ registry: served, ...options, runTimeouts }),
        )
        // Advanced, and then nobody runs its attempt.
        const { run } = yield* start({ name: 'flow', input: 1 })

        yield* elapse(9_000)
        expect((yield* load(run.id)).run.status).toBe('running')
        yield* elapse(1_000)
        expect((yield* load(run.id)).run.status).toBe(status)
        yield* elapse(120_000)
        expect((yield* load(run.id)).run.status).toBe(status)
      }),
    )
  })
})
