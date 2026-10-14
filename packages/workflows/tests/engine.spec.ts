import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as TestClock from 'effect/testing/TestClock'

import type {
  Mutation,
  WorkflowProgram as Program,
  Registry,
  RetryPolicy,
  StartInput,
} from '../src/index.ts'
import {
  begin as beginAttempt,
  cancel,
  coordinate,
  InMemory,
  settle,
  StaleClaim,
  start,
  Store,
} from '../src/index.ts'
import * as support from './support.ts'
import {
  claimAttempts,
  completed,
  failed,
  LEASE,
  load,
  pass,
  unused,
  work,
} from './support.ts'

/** Two steps, the second computed from the first, and a result from both. */
function order(retry?: RetryPolicy): Program {
  return {
    kind: 'workflow',
    name: 'order',
    steps: [
      {
        kind: 'activity',
        execute: unused,
        name: 'price',
        input: (_outputs, input) => input,
        ...(retry === undefined ? {} : { retry }),
      },
      {
        kind: 'activity',
        execute: unused,
        name: 'charge',
        input: ({ price }) => ({ cents: (price as number) * 100 }),
      },
    ],
    result: ({ price, charge }) => ({ price, charge }),
  }
}

/** A parent that starts `order` as a child and reads what it produced. */
function checkout(cancellation?: 'propagate' | 'detach'): Program {
  return {
    kind: 'workflow',
    name: 'checkout',
    steps: [
      {
        kind: 'workflow',
        name: 'order',
        workflow: { name: 'order' },
        input: (_outputs, input) => input,
        ...(cancellation === undefined ? {} : { cancellation }),
      },
      {
        kind: 'activity',
        execute: unused,
        name: 'notify',
        input: ({ order }) => (order as { charge: string }).charge,
      },
    ],
    result: ({ notify }) => notify,
  }
}

const setup = (
  programs: readonly Program[] = [order()],
  options?: InMemory.InMemoryOptions,
) => support.setup(programs, options)

const begin = (input: Omit<StartInput, 'name'> & { name?: string }) =>
  start({ name: 'order', ...input })

describe('a run of sequential steps', () => {
  it.effect(
    'opens each step from the outputs before it and ends with the result',
    () => {
      const { served, provide, inspect } = setup()

      return provide(
        Effect.gen(function* () {
          const { run, created } = yield* begin({ input: 7 })
          expect(created).toBe(true)
          expect(run.status).toBe('queued')

          expect(yield* pass(served)).toBe(1)
          const opened = yield* load(run.id)
          expect(opened.run.status).toBe('running')
          expect(opened.nodes).toMatchObject([
            { name: 'price', status: 'running', input: 7 },
          ])
          expect(opened.attempts).toMatchObject([
            { status: 'started', attemptNumber: 1, input: 7 },
          ])

          expect(yield* work(served, completed(7))).toBe('settled')
          yield* pass(served)
          expect((yield* load(run.id)).nodes).toMatchObject([
            { name: 'price', status: 'completed', output: 7 },
            { name: 'charge', status: 'running', input: { cents: 700 } },
          ])

          yield* work(served, completed('paid'))
          yield* pass(served)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: { price: 7, charge: 'paid' },
          })
          expect(inspect.queue()).toStrictEqual([])
        }),
      )
    },
  )

  it.effect('does nothing in a pass that finds nothing new', () => {
    const { served, provide, store } = setup()

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        yield* pass(served)
        const before = yield* load(run.id)

        // A wake with no news, as a duplicate delivery would be.
        yield* store.transact({ runs: [run.id] }, () => ({
          _tag: 'Commit',
          result: undefined,
          mutation: {
            enqueue: [
              {
                command: { kind: 'continueRun', runId: run.id, name: 'order' },
                dedupe: `continue:${run.id}`,
              },
            ],
          },
        }))
        expect(yield* pass(served)).toBe(1)

        expect(yield* load(run.id)).toStrictEqual(before)
      }),
    )
  })

  it.effect(
    'fails the run when a step input or the result cannot be computed',
    () => {
      const broken: Program = {
        kind: 'workflow',
        name: 'broken',
        steps: [
          {
            kind: 'activity',
            execute: unused,
            name: 'first',
            input: () => {
              throw new Error('no input')
            },
          },
        ],
        result: () => undefined,
      }
      const unfinishable: Program = {
        kind: 'workflow',
        name: 'unfinishable',
        steps: [],
        result: () => {
          throw new Error('no result')
        },
      }
      const { served, provide, inspect } = setup([broken, unfinishable])

      return provide(
        Effect.gen(function* () {
          const first = yield* start({ name: 'broken', input: 1 })
          const second = yield* start({ name: 'unfinishable', input: 1 })
          yield* pass(served)

          const { run, nodes, attempts } = yield* load(first.run.id)
          expect(run).toMatchObject({
            status: 'failed',
            error: { message: 'no input' },
          })
          expect(nodes).toMatchObject([{ name: 'first', status: 'failed' }])
          expect(attempts).toStrictEqual([])
          expect((yield* load(second.run.id)).run).toMatchObject({
            status: 'failed',
            error: { message: 'no result' },
          })
          expect(inspect.queue()).toStrictEqual([])
        }),
      )
    },
  )
})

describe('a run that fails', () => {
  it.effect('stores an error whose causes come back to itself', () => {
    const cyclic = new Error('declined')
    cyclic.cause = new Error('gateway', { cause: cyclic })
    const { served, provide, inspect } = setup([
      {
        kind: 'workflow',
        name: 'order',
        steps: [
          {
            kind: 'activity',
            execute: unused,
            name: 'price',
            input: () => {
              throw cyclic
            },
          },
        ],
        result: () => 'done',
      },
    ])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        expect(yield* pass(served)).toBe(1)

        const { error, status } = (yield* load(run.id)).run
        expect(status).toBe('failed')
        const messages: string[] = []
        for (let at = error; at; at = at.cause) messages.push(at.message)
        // The error and five of its causes, one under the other.
        expect(messages).toStrictEqual([
          'declined',
          'gateway',
          'declined',
          'gateway',
          'declined',
          'gateway',
        ])
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect(
    'fails for a failed node though one before it was cancelled',
    () => {
      const { served, provide, store } = setup()

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin({ input: 1 })
          const node = { runId: run.id, kind: 'activity', version: 1 } as const
          const at = { createdAt: 0, updatedAt: 0 }
          // Written as found: no pass leaves a run so, and a pass that finds
          // one must still say that it failed.
          yield* store.transact({ runs: [run.id] }, () => ({
            _tag: 'Commit',
            result: undefined,
            mutation: {
              runs: [{ ...run, status: 'running', version: 2 }],
              nodes: [
                { ...node, ...at, name: 'price', status: 'cancelled' },
                {
                  ...node,
                  ...at,
                  name: 'charge',
                  status: 'failed',
                  error: { message: 'declined' },
                },
              ],
            },
          }))

          yield* pass(served)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'failed',
            error: { message: 'declined' },
          })
        }),
      )
    },
  )
})

describe('attempts', () => {
  it.effect('retries within the budget, each attempt after its backoff', () => {
    const retry = { attempts: 3, delay: '1s', backoff: 'exponential' } as const
    const { served, provide } = setup([order(retry)])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        yield* pass(served)

        expect(yield* work(served, failed('first'))).toBe('retrying')
        // The second attempt waits 1s, the third 2s.
        yield* TestClock.adjust(999)
        expect(yield* claimAttempts(served)).toStrictEqual([])
        yield* TestClock.adjust(1)
        expect(yield* work(served, failed('second'))).toBe('retrying')
        yield* TestClock.adjust(1_999)
        expect(yield* claimAttempts(served)).toStrictEqual([])
        yield* TestClock.adjust(1)
        expect(yield* work(served, failed('third'))).toBe('settled')

        yield* pass(served)
        const { run: ended, nodes, children, attempts } = yield* load(run.id)
        expect(ended).toMatchObject({
          status: 'failed',
          error: { message: 'third' },
        })
        // The step after the failed one never opened.
        expect(nodes).toMatchObject([{ name: 'price', status: 'failed' }])
        expect(children).toMatchObject([{ status: 'failed', attemptCount: 3 }])
        expect(
          attempts.map(({ status, attemptNumber, error }) => ({
            status,
            attemptNumber,
            message: error?.message,
          })),
        ).toStrictEqual([
          { status: 'failed', attemptNumber: 1, message: 'first' },
          { status: 'failed', attemptNumber: 2, message: 'second' },
          { status: 'failed', attemptNumber: 3, message: 'third' },
        ])
      }),
    )
  })

  it.effect(
    'fails the step on its first failure when nothing allows a retry',
    () => {
      const { served, provide } = setup()

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin({ input: 1 })
          yield* pass(served)

          expect(yield* work(served, failed('once'))).toBe('settled')
          yield* pass(served)

          expect((yield* load(run.id)).run.status).toBe('failed')
        }),
      )
    },
  )

  it.effect('lets only the delivery that holds the command settle it', () => {
    const { served, provide } = setup()

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        yield* pass(served)

        const [slow] = yield* claimAttempts(served, 1_000)
        yield* TestClock.adjust(1_000)
        const [fast] = yield* claimAttempts(served, 1_000)
        expect(fast).toMatchObject({ id: slow!.id, deliveries: 2 })

        // The first delivery lost its claim while it worked.
        const lost = yield* Effect.exit(
          settle(served, slow!, completed('late')),
        )
        expect(lost).toStrictEqual(
          Exit.fail(expect.objectContaining({ _tag: 'StaleClaim' })),
        )
        expect((yield* load(run.id)).attempts).toMatchObject([
          { status: 'started' },
        ])

        expect(yield* settle(served, fast!, completed('on time'))).toBe(
          'settled',
        )
        expect((yield* load(run.id)).attempts).toMatchObject([
          { status: 'completed', output: 'on time' },
        ])
      }),
    )
  })

  it.effect('tells only the delivery that holds the command to begin', () => {
    const { served, provide } = setup()

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        yield* pass(served)
        const [expired] = yield* claimAttempts(served)
        yield* TestClock.adjust(LEASE)
        const [current] = yield* claimAttempts(served)

        // The first delivery woke up late: the work is another's by now.
        const stale = yield* Effect.flip(beginAttempt(served, expired!))
        expect(stale).toStrictEqual(new StaleClaim({ commandId: expired!.id }))
        expect(stale.message).toBe(
          `The claim of workflow command [${expired!.id}] is no longer held`,
        )
        expect(yield* beginAttempt(served, current!)).toMatchObject({
          _tag: 'Begun',
          attempt: { runId: run.id, nodeName: 'price', attemptNumber: 1 },
        })
      }),
    )
  })

  it.effect('sets a command aside once it was delivered too often', () => {
    const { served, provide, inspect } = setup([order()], { maxDeliveries: 2 })

    return provide(
      Effect.gen(function* () {
        yield* begin({ input: 1 })
        yield* pass(served)

        for (const deliveries of [1, 2]) {
          expect(yield* claimAttempts(served, 1_000)).toMatchObject([
            { deliveries },
          ])
          yield* TestClock.adjust(1_000)
        }

        expect(yield* claimAttempts(served, 1_000)).toStrictEqual([])
        expect(inspect.queue()).toStrictEqual([])
        expect(inspect.dead()).toMatchObject([
          { command: { kind: 'runAttempt', nodeName: 'price' } },
        ])
      }),
    )
  })

  it.effect('gives a released command back after its delay', () => {
    const { served, provide, store } = setup()

    return provide(
      Effect.gen(function* () {
        yield* begin({ input: 1 })
        yield* pass(served)

        const [claim] = yield* claimAttempts(served)
        yield* store.release(claim!, { delayMs: 500 })
        expect(yield* claimAttempts(served)).toStrictEqual([])
        yield* TestClock.adjust(500)

        // Given back without an error, the delivery did not count.
        expect(yield* claimAttempts(served)).toMatchObject([
          { id: claim!.id, deliveries: 1 },
        ])
        // The released claim is spent.
        expect(yield* Effect.exit(store.release(claim!))).toStrictEqual(
          Exit.fail(expect.objectContaining({ _tag: 'StaleClaim' })),
        )
      }),
    )
  })
})

describe('cancellation', () => {
  it.effect('discards an outcome that arrives after the request', () => {
    const { served, provide, inspect } = setup()

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        yield* pass(served)
        const [claim] = yield* claimAttempts(served)

        expect(yield* cancel(run.id)).toMatchObject({ status: 'cancelling' })
        expect(yield* settle(served, claim!, completed(1))).toBe('stale')
        yield* pass(served)

        const { run: ended, nodes, attempts } = yield* load(run.id)
        expect(ended.status).toBe('cancelled')
        expect(nodes).toMatchObject([{ name: 'price', status: 'cancelled' }])
        expect(attempts).toMatchObject([{ status: 'cancelled' }])
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect('keeps an outcome that arrived before the request', () => {
    const { served, provide, inspect } = setup()

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        yield* pass(served)

        expect(yield* work(served, completed(1))).toBe('settled')
        yield* cancel(run.id)
        yield* pass(served)

        const { run: ended, nodes } = yield* load(run.id)
        expect(ended.status).toBe('cancelled')
        // The settled step stays settled; the next one never opens.
        expect(nodes).toMatchObject([
          { name: 'price', status: 'completed', output: 1 },
        ])
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect('keeps a wake that arrives while a pass holds the command', () => {
    const { served, provide, inspect, store } = setup()

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1 })
        const [claim] = yield* store.claim({
          lanes: [{ kind: 'continueRun', routes: served.workflows }],
          limit: 1,
          leaseMs: LEASE,
        })

        // Arrives after the pass claimed its command and before it commits.
        yield* cancel(run.id)
        yield* coordinate(served, claim!)

        expect((yield* load(run.id)).run.status).toBe('cancelled')
        expect(inspect.queue()).toMatchObject([
          { command: { kind: 'continueRun', runId: run.id } },
        ])
        expect(yield* pass(served)).toBe(1)
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect('ends at once a run that was not to start yet', () => {
    const { served, provide, inspect } = setup()

    return provide(
      Effect.gen(function* () {
        const { run } = yield* begin({ input: 1, startAt: 60_000 })
        expect(yield* pass(served)).toBe(0)

        yield* cancel(run.id)
        // The request's wake is the one that waited for the start: it is
        // due now, not when the run was to begin.
        expect(yield* pass(served)).toBe(1)
        expect((yield* load(run.id)).run.status).toBe('cancelled')
        expect(inspect.queue()).toStrictEqual([])
      }),
    )
  })

  it.effect(
    'answers for a run that has ended, or never existed, without changing it',
    () => {
      const { served, provide } = setup([
        { kind: 'workflow', name: 'order', steps: [], result: () => 'done' },
      ])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin({ input: 1 })
          yield* pass(served)

          expect(yield* cancel(run.id)).toMatchObject({ status: 'completed' })
          expect(yield* cancel('run-missing')).toBeUndefined()
        }),
      )
    },
  )
})

describe('commits', () => {
  it.effect(
    'change nothing when one is aborted, and happen once when retried',
    () => {
      let abort = true
      const { served, provide, inspect } = setup([order()], {
        beforeCommit: () => {
          if (abort) throw new Error('lost connection')
        },
      })

      return provide(
        Effect.gen(function* () {
          abort = false
          const { run } = yield* begin({ input: 1 })
          const before = yield* load(run.id)

          abort = true
          const died = yield* Effect.exit(pass(served))
          expect(Exit.isFailure(died)).toBe(true)
          // Nothing of the pass is stored, and its command is still claimed.
          expect(yield* load(run.id)).toStrictEqual(before)
          expect(inspect.queue()).toMatchObject([
            { command: { kind: 'continueRun' }, deliveries: 1 },
          ])

          abort = false
          yield* TestClock.adjust(LEASE)
          expect(yield* pass(served)).toBe(1)
          expect((yield* load(run.id)).attempts).toHaveLength(1)
          expect(inspect.queue()).toMatchObject([
            { command: { kind: 'runAttempt' } },
          ])
        }),
      )
    },
  )

  it.effect(
    'plan again when what they read changed before they committed',
    () => {
      const competitors: string[] = []
      const memory = InMemory.makeInMemoryStore({
        beforeCommit: (mutation: Mutation) => {
          // A competing start takes the key between this plan and its commit.
          if (competitors.length > 0 || !mutation.keys?.length) return
          competitors.push('pending')
          const { run } = Effect.runSync(
            Effect.provideService(
              start({
                name: 'order',
                input: 2,
                unique: { key: ['k'], behavior: 'join' },
              }),
              Store,
              memory.store,
            ),
          )
          competitors[0] = run.id
        },
      })

      return Effect.provideService(
        Effect.gen(function* () {
          const joined = yield* start({
            name: 'order',
            input: 1,
            unique: { key: ['k'], behavior: 'join' },
          })

          // The first plan would have created a run; the second joined the winner.
          expect(joined).toMatchObject({
            created: false,
            run: { id: competitors[0], input: 2 },
          })
          expect(memory.inspect.runs()).toHaveLength(1)
          expect(memory.inspect.queue()).toHaveLength(1)
        }),
        Store,
        memory.store,
      )
    },
  )
})

describe('identity keys', () => {
  it.effect(
    'answer a repeated request with its run and refuse another under the key',
    () => {
      const { provide, inspect } = setup()

      return provide(
        Effect.gen(function* () {
          const first = yield* begin({
            input: { a: 1, b: 2 },
            idempotencyKey: ['k'],
          })
          const again = yield* begin({
            input: { b: 2, a: 1 },
            idempotencyKey: ['k'],
          })
          expect(again).toStrictEqual({ run: first.run, created: false })
          expect(inspect.queue()).toHaveLength(1)

          const other = yield* Effect.exit(
            begin({ input: { a: 2 }, idempotencyKey: ['k'] }),
          )
          expect(other).toStrictEqual(
            Exit.fail(
              expect.objectContaining({
                _tag: 'IdempotencyConflict',
                runId: first.run.id,
                message: `Conflicting idempotent run [order]: run [${first.run.id}] owns the key`,
              }),
            ),
          )
          expect(inspect.runs()).toHaveLength(1)
        }),
      )
    },
  )

  it.effect('tell a field named `__proto__` from no field at all', () => {
    const { provide, inspect } = setup()
    // As it arrives in a request: an own field, not a prototype.
    const own: unknown = JSON.parse('{"__proto__":{"admin":true}}')

    return provide(
      Effect.gen(function* () {
        const first = yield* begin({ input: 1, idempotencyKey: [own] })
        const second = yield* begin({ input: 1, idempotencyKey: [{}] })
        expect(second.created).toBe(true)
        expect(second.run.id).not.toBe(first.run.id)

        yield* begin({ input: own, idempotencyKey: ['k'] })
        const other = yield* Effect.exit(
          begin({ input: {}, idempotencyKey: ['k'] }),
        )
        expect(other).toStrictEqual(
          Exit.fail(expect.objectContaining({ _tag: 'IdempotencyConflict' })),
        )
        expect(inspect.runs()).toHaveLength(3)
      }),
    )
  })

  it.effect(
    'hold an active key until the run ends and an all key for good',
    () => {
      const { served, provide } = setup([
        { kind: 'workflow', name: 'order', steps: [], result: () => 'done' },
      ])
      const refused = (runId: string, scope: string) =>
        Exit.fail(
          expect.objectContaining({
            _tag: 'RunConflict',
            runId,
            message: `Run [${runId}] already holds unique key [scope: ${scope}]`,
          }),
        )

      return provide(
        Effect.gen(function* () {
          const active = { key: ['a'] } as const
          const all = { key: ['a'], scope: 'all' } as const

          const first = yield* begin({ input: 1, unique: active })
          const kept = yield* begin({ input: 1, unique: all })
          expect(
            yield* Effect.exit(begin({ input: 1, unique: active })),
          ).toStrictEqual(refused(first.run.id, 'active'))

          yield* pass(served)
          expect((yield* load(first.run.id)).run.status).toBe('completed')

          // The ended run freed its active key; the all key is spent.
          const second = yield* begin({ input: 1, unique: active })
          expect(second.created).toBe(true)
          expect(
            yield* Effect.exit(begin({ input: 1, unique: all })),
          ).toStrictEqual(refused(kept.run.id, 'all'))
        }),
      )
    },
  )

  it.effect('join a pinned run only as the same workflow and revision', () => {
    const { provide } = setup()

    return provide(
      Effect.gen(function* () {
        const unique = { key: ['j'], behavior: 'join' } as const
        const first = yield* begin({ input: 1, unique, revision: 'v1' })

        // Joining ignores the input: the key alone names the work.
        expect(
          yield* begin({ input: 2, unique, revision: 'v1' }),
        ).toStrictEqual({ run: first.run, created: false })

        const refused = Exit.fail(
          expect.objectContaining({
            _tag: 'RunConflict',
            runId: first.run.id,
            status: 'queued',
            key: ['j'],
            scope: 'active',
            holder: { kind: 'workflow', name: 'order', revision: 'v1' },
            message: `Run [${first.run.id}] of workflow [order@v1] already holds unique key [scope: active] and cannot be joined as another workflow, task or revision`,
          }),
        )
        for (const other of [
          { revision: 'v2' },
          // The unversioned lane is no wildcard.
          {},
          { revision: 'v1', kind: 'task' },
          { revision: 'v1', name: 'other' },
        ] as const) {
          expect(
            yield* Effect.exit(begin({ input: 1, unique, ...other })),
          ).toStrictEqual(refused)
        }
      }),
    )
  })

  it.effect('join two unversioned runs whatever they are', () => {
    const { provide, inspect } = setup()

    return provide(
      Effect.gen(function* () {
        const unique = { key: ['j'], behavior: 'join' } as const
        const first = yield* begin({ input: 1, unique })

        expect(
          yield* begin({ input: 2, unique, name: 'other', kind: 'task' }),
        ).toStrictEqual({ run: first.run, created: false })
        // A run that does not ask to join is refused, and told nothing of
        // what holds the key.
        const rejected = yield* Effect.flip(
          begin({ input: 1, unique: { key: ['j'] } }),
        )
        expect(rejected).toMatchObject({ runId: first.run.id })
        expect(rejected).not.toHaveProperty('holder')
        expect(inspect.runs()).toHaveLength(1)
      }),
    )
  })
})

describe('routing', () => {
  it.effect(
    'leaves a run of a revision nobody serves queued and untouched',
    () => {
      const { served, provide, inspect } = setup()

      return provide(
        Effect.gen(function* () {
          const { run } = yield* begin({ input: 1, revision: 'v2' })

          expect(yield* pass(served)).toBe(0)
          expect((yield* load(run.id)).run.status).toBe('queued')
          expect(inspect.queue()).toMatchObject([
            { command: { runId: run.id, revision: 'v2' }, deliveries: 0 },
          ])
        }),
      )
    },
  )
})

describe('child workflows', () => {
  /** Runs passes and completes attempts until nothing is due. */
  const drain = Effect.fnUntraced(function* (served: Registry) {
    for (let round = 0; round < 50; round++) {
      const passed = yield* pass(served)
      const claims = yield* claimAttempts(served)
      for (const claim of claims) {
        yield* settle(
          served,
          claim,
          completed(`${claim.command.nodeName} done`),
        )
      }
      if (passed === 0 && claims.length === 0) return
    }
    return yield* Effect.die('Did not settle')
  })

  it.effect(
    'wake the parent, which reads the outcome and moves on in one pass',
    () => {
      const { served, provide } = setup([order(), checkout()])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'checkout', input: 3 })
          yield* pass(served)

          const waiting = yield* load(run.id)
          expect(waiting.run.status).toBe('waiting')
          const childRunId = waiting.children[0]!.childRunId!
          expect((yield* load(childRunId)).run).toMatchObject({
            name: 'order',
            status: 'queued',
            input: 3,
            parentRunId: run.id,
            parentNodeName: 'order',
            rootRunId: run.id,
          })

          // The child's own passes and attempts, up to its completion.
          yield* pass(served)
          yield* work(served, completed(3))
          yield* pass(served)
          yield* work(served, completed('paid'))
          yield* pass(served)
          expect((yield* load(childRunId)).run.status).toBe('completed')

          // One parent pass settles the child's node and opens the next step.
          expect(yield* pass(served)).toBe(1)
          expect((yield* load(run.id)).nodes).toMatchObject([
            {
              name: 'order',
              status: 'completed',
              output: { price: 3, charge: 'paid' },
            },
            { name: 'notify', status: 'running', input: 'paid' },
          ])

          yield* drain(served)
          expect((yield* load(run.id)).run).toMatchObject({
            status: 'completed',
            output: 'notify done',
          })
        }),
      )
    },
  )

  it.effect('fail the parent with the error the child failed with', () => {
    const { served, provide } = setup([order(), checkout()])

    return provide(
      Effect.gen(function* () {
        const { run } = yield* start({ name: 'checkout', input: 3 })
        yield* pass(served)
        yield* pass(served)
        yield* work(served, failed('card declined'))
        yield* pass(served)
        yield* pass(served)

        const { run: ended, nodes } = yield* load(run.id)
        expect(ended).toMatchObject({
          status: 'failed',
          error: { message: 'card declined' },
        })
        expect(nodes).toMatchObject([{ name: 'order', status: 'failed' }])
      }),
    )
  })

  it.effect.each([
    {
      policy: 'propagate',
      // The child settles in a pass of its own, and the parent waits for it.
      parent: 'cancelling',
      child: 'cancelled',
      attempt: 'cancelled',
    },
    {
      policy: 'detach',
      parent: 'cancelled',
      child: 'running',
      attempt: 'started',
    },
  ] as const)(
    'are cancelled with their parent unless detached: $policy',
    ({ policy, parent, child, attempt }) => {
      const { served, provide } = setup([order(), checkout(policy)])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'checkout', input: 3 })
          yield* pass(served)
          yield* pass(served)
          const childRunId = (yield* load(run.id)).children[0]!.childRunId!

          yield* cancel(run.id)
          yield* pass(served)
          expect((yield* load(run.id)).run.status).toBe(parent)
          yield* pass(served)

          const ended = yield* load(childRunId)
          expect(ended.run.status).toBe(child)
          expect(ended.attempts).toMatchObject([{ status: attempt }])
          // The child's end wakes the parent, which ends then.
          yield* pass(served)
          expect((yield* load(run.id)).run.status).toBe('cancelled')
        }),
      )
    },
  )

  describe('cancelled with their parent', () => {
    /** A workflow whose one step is a child workflow, or an activity. */
    const nest = (name: string, child?: string): Program => ({
      kind: 'workflow',
      name,
      steps: [
        child === undefined
          ? {
              kind: 'activity',
              execute: unused,
              name: 'hold',
              input: (_outputs, input) => input,
            }
          : {
              kind: 'workflow',
              name: child,
              workflow: { name: child },
              input: (_outputs, input) => input,
            },
      ],
      result: (outputs) => Object.values(outputs)[0],
    })
    const status = (runId: string) =>
      Effect.map(load(runId), ({ run }) => run.status)
    const childRun = (runId: string, index = 0) =>
      Effect.map(load(runId), ({ children }) => children[index]!.childRunId!)

    it.effect('end the root only once every run under it has ended', () => {
      const { served, provide, inspect } = setup([
        nest('root', 'mid'),
        nest('mid', 'leaf'),
        nest('leaf'),
      ])

      return provide(
        Effect.gen(function* () {
          const { run } = yield* start({ name: 'root', input: 1 })
          yield* pass(served)
          const mid = yield* childRun(run.id)
          yield* pass(served)
          const leaf = yield* childRun(mid)
          yield* pass(served)
          // The leaf's handler is running when the root is cancelled.
          const [claim] = yield* claimAttempts(served)

          yield* cancel(run.id)
          const family = Effect.all([status(run.id), status(mid), status(leaf)])
          const seen = [yield* family]
          while ((yield* pass(served)) > 0) seen.push(yield* family)

          // Each run is told in its parent's pass and waits for its own
          // child; the end comes back up one wake at a time.
          expect(seen).toStrictEqual([
            ['cancelling', 'waiting', 'running'],
            ['cancelling', 'cancelling', 'running'],
            ['cancelling', 'cancelling', 'cancelling'],
            ['cancelling', 'cancelling', 'cancelled'],
            ['cancelling', 'cancelled', 'cancelled'],
            ['cancelled', 'cancelled', 'cancelled'],
          ])
          expect(yield* settle(served, claim!, completed(1))).toBe('stale')
          expect(inspect.queue()).toStrictEqual([])
        }),
      )
    })

    it.effect(
      'keep a run whose child was cancelled alone cancelling until its other children end',
      () => {
        const { served, provide } = setup([
          {
            kind: 'workflow',
            name: 'pair',
            steps: [
              {
                kind: 'parallel',
                name: 'both',
                members: {
                  a: {
                    kind: 'workflow',
                    workflow: { name: 'leaf' },
                    input: () => 'a',
                  },
                  b: {
                    kind: 'workflow',
                    workflow: { name: 'leaf' },
                    input: () => 'b',
                  },
                },
              },
            ],
            result: ({ both }) => both,
          },
          nest('leaf'),
        ])

        return provide(
          Effect.gen(function* () {
            const { run } = yield* start({ name: 'pair', input: 1 })
            yield* pass(served)
            const [a, b] = [
              yield* childRun(run.id, 0),
              yield* childRun(run.id, 1),
            ]
            yield* pass(served)

            yield* cancel(a)
            const family = Effect.all([status(run.id), status(a), status(b)])
            const seen = [yield* family]
            while ((yield* pass(served)) > 0) seen.push(yield* family)

            // The parent's pass that reads `a` cancelled stops `b`, and the
            // parent waits for it as it would after a request of its own.
            expect(seen).toStrictEqual([
              ['waiting', 'cancelling', 'running'],
              ['waiting', 'cancelled', 'running'],
              ['cancelling', 'cancelled', 'cancelling'],
              ['cancelling', 'cancelled', 'cancelled'],
              ['cancelled', 'cancelled', 'cancelled'],
            ])
          }),
        )
      },
    )
  })
})
