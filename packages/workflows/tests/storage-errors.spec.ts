import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import type { Execute, Program, WorkflowProgram } from '../src/index.ts'
import {
  Client,
  schedule,
  start,
  StorageError,
  Store,
  task,
  Worker,
} from '../src/index.ts'
import { elapse, idle, LEASE, load, setup } from './support.ts'

const POLL = 1_000
const down = new StorageError({ cause: 'connection reset' })

const flow = (execute: Execute): WorkflowProgram => ({
  kind: 'workflow',
  name: 'flow',
  steps: [
    {
      kind: 'activity',
      name: 'act',
      execute,
      input: (_outputs, input) => input,
    },
  ],
  result: ({ act }) => act,
})

type Operation = keyof Store['Service']

/**
 * A store over the in-memory one whose operations fail as a storage would,
 * for as long as `failing` names them. `store` is the one underneath, which
 * never fails.
 */
function flaky(programs: readonly Program[]) {
  const made = setup(programs)
  const { store } = made
  const failing = new Set<Operation>()
  const failed: Operation[] = []
  const failable = <A, E>(
    operation: Operation,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | StorageError> =>
    Effect.suspend((): Effect.Effect<A, E | StorageError> => {
      if (!failing.has(operation)) return effect
      failed.push(operation)
      return Effect.fail(down)
    })
  const broken = Store.of({
    ...store,
    transact: (scope, plan) =>
      failable('transact', store.transact(scope, plan)),
    claim: (options) => failable('claim', store.claim(options)),
    release: (claim, options) =>
      failable('release', store.release(claim, options)),
    renew: (claim, leaseMs) => failable('renew', store.renew(claim, leaseMs)),
    load: (runId) => failable('load', store.load(runId)),
    runs: (query) => failable('runs', store.runs(query)),
    dead: (query) => failable('dead', store.dead(query)),
    schedules: (query) => failable('schedules', store.schedules(query)),
    prunable: (query) => failable('prunable', store.prunable(query)),
  })
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Store, broken)
  /** Runs against the store underneath, behind the failing one's back. */
  const beneath = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Store, store)
  return { ...made, provide, beneath, failing, failed }
}

describe('a coordinator whose store fails', () => {
  it.effect(
    'gives the command back with the failure, and works it later',
    () => {
      const { served, provide, beneath, inspect, failing, failed } = flaky([
        flow(() => Effect.succeed('done')),
      ])

      return provide(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.forkScoped(
              Worker.coordinator({
                registry: served,
                pollMs: POLL,
                reaping: false,
                runTimeouts: false,
              }),
            )
            yield* idle
            failing.add('transact')
            // Started behind the failing store's back.
            const { run } = yield* beneath(start({ name: 'flow', input: 1 }))
            yield* idle

            expect(failed).toEqual(['transact'])
            expect(worker.pollUnsafe()).toBeUndefined()
            // It counts against the command, and waits before its next turn.
            expect(inspect.queue()).toMatchObject([
              {
                command: { kind: 'continueRun', runId: run.id },
                deliveries: 1,
                availableAt: POLL,
                error: {
                  name: 'StorageError',
                  message: 'Workflow storage failed',
                },
              },
            ])
            expect(inspect.queue()[0]).not.toHaveProperty('claim')

            failing.clear()
            yield* elapse(POLL)
            expect((yield* load(run.id)).run.status).toBe('running')
            expect(worker.pollUnsafe()).toBeUndefined()
          }),
        ),
      )
    },
  )

  it.effect(
    'leaves a command to its lease when it cannot even give it back',
    () => {
      const { served, provide, beneath, inspect, failing } = flaky([
        flow(() => Effect.succeed('done')),
      ])

      return provide(
        Effect.scoped(
          Effect.gen(function* () {
            const worker = yield* Effect.forkScoped(
              Worker.coordinator({
                registry: served,
                pollMs: POLL,
                leaseMs: LEASE,
                reaping: false,
                runTimeouts: false,
              }),
            )
            yield* idle
            failing.add('transact').add('release')
            const { run } = yield* beneath(start({ name: 'flow', input: 1 }))
            yield* idle
            expect(inspect.queue()).toMatchObject([
              { deliveries: 1, claim: { expiresAt: LEASE } },
            ])
            expect(inspect.queue()[0]).not.toHaveProperty('error')

            failing.clear()
            yield* elapse(LEASE)
            expect((yield* load(run.id)).run.status).toBe('running')
            expect(worker.pollUnsafe()).toBeUndefined()
          }),
        ),
      )
    },
  )

  it.effect('fails when the store fails it as it starts', () => {
    const Job = task({
      name: 'job',
      pool: 'jobs',
      input: Schema.Number,
      output: Schema.Number,
      handler: (input) => Effect.succeed(input),
    })
    const { provide, failing } = flaky([])
    failing.add('transact')

    return provide(
      Effect.gen(function* () {
        const worker = yield* Effect.forkChild(
          Worker.coordinator({
            workflows: [],
            schedules: [
              schedule({ name: 's', runnable: Job, input: 1, every: '1h' }),
            ],
          }),
        )
        expect(yield* Effect.flip(Fiber.join(worker))).toBe(down)
      }),
    )
  })

  it.effect('goes on with a maintenance job at its next turn', () => {
    const Job = task({
      name: 'job',
      pool: 'jobs',
      input: Schema.Number,
      output: Schema.Number,
      handler: (input) => Effect.succeed(input),
    })
    const { provide, failing, failed } = flaky([])

    return provide(
      Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* Effect.forkScoped(
            Worker.coordinator({
              workflows: [],
              pollMs: POLL,
              reaping: false,
              runTimeouts: false,
              schedules: [
                schedule({
                  name: 's',
                  runnable: Job,
                  input: 1,
                  every: '1h',
                  immediately: true,
                }),
              ],
              scheduling: { everyMs: 5_000 },
            }),
          )
          yield* idle
          failing.add('schedules')
          yield* elapse(5_000)
          expect(failed).toEqual(['schedules'])
          expect((yield* Client.list()).runs).toEqual([])

          failing.clear()
          yield* elapse(5_000)
          expect((yield* Client.list()).runs).toHaveLength(1)
          expect(worker.pollUnsafe()).toBeUndefined()
        }),
      ),
    )
  })
})

describe('an execution worker whose store fails', () => {
  it.effect(
    'runs the handler again when its outcome could not be stored',
    () => {
      let ran = 0
      const { served, provide, beneath, inspect, failing } = flaky([
        flow(() =>
          Effect.sync(() => {
            ran += 1
            // The store fails from the moment the handler first ends.
            if (ran === 1) failing.add('transact')
            return `ran ${ran}`
          }),
        ),
      ])

      return provide(
        Effect.scoped(
          Effect.gen(function* () {
            const { run } = yield* start({ name: 'flow', input: 1 })
            yield* beneath(
              Effect.forkScoped(
                Worker.coordinator({ registry: served, pollMs: POLL }),
              ),
            )
            const worker = yield* Effect.forkScoped(
              Worker.execution({ registry: served, pollMs: POLL }),
            )
            yield* idle
            expect(ran).toBe(1)
            expect(inspect.queue()).toMatchObject([
              {
                command: { kind: 'runAttempt' },
                deliveries: 1,
                error: { name: 'StorageError' },
              },
            ])

            failing.clear()
            yield* elapse(3 * POLL)
            expect(yield* load(run.id)).toMatchObject({
              run: { status: 'completed', output: 'ran 2' },
              // Still the one attempt: it was delivered twice.
              attempts: [{ attemptNumber: 1, status: 'completed' }],
            })
            expect(worker.pollUnsafe()).toBeUndefined()
          }),
        ),
      )
    },
  )
})

describe('the client', () => {
  const Job = task({
    name: 'job',
    pool: 'jobs',
    input: Schema.Number,
    output: Schema.Number,
    handler: (input) => Effect.succeed(input),
  })

  it.effect('gives a storage failure to its caller', () => {
    const { provide, inspect, failing } = flaky([])
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Job, 1)
        for (const operation of ['transact', 'load', 'runs', 'dead'] as const) {
          failing.add(operation)
        }

        const failures: readonly Effect.Effect<unknown, unknown, Store>[] = [
          Client.start(Job, 2),
          Client.cancel(run.id),
          Client.get(run.id),
          Client.inspect(run.id),
          Client.getDetail(run.id),
          Client.getNode(run.id, '$task'),
          Client.getFamily(run.id),
          Client.list(),
          Client.listSummaries(),
          Client.retry(run.id),
          Client.restart(run.id, { definitions: [Job] }),
          Client.listDeadCommands(),
          Client.requeueDeadCommand('none'),
          Client.deleteRun(run.id),
          Client.schedules.trigger('s'),
          Client.schedules.setEnabled('s', true),
          Stream.runCollect(Client.watch(run.id)),
        ]
        for (const failure of failures) {
          expect(yield* Effect.flip(failure)).toBe(down)
        }
        // Nothing was written by what failed.
        expect(inspect.runs()).toHaveLength(1)
        expect(inspect.runs()[0]!.run.status).toBe('queued')
      }),
    )
  })

  it.effect('gives the failure of a sweep it was running', () => {
    const { provide, failing } = flaky([])
    failing.add('schedules').add('prunable')

    return provide(
      Effect.gen(function* () {
        expect(yield* Effect.flip(Client.schedules.list())).toBe(down)
        expect(yield* Effect.flip(Client.pruneRuns({ olderThan: 1 }))).toBe(
          down,
        )
      }),
    )
  })
})
