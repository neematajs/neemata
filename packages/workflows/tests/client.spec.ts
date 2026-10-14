import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'

import type {
  DecodedRun,
  DefinitionConflict,
  IdempotencyConflict,
  Mutation,
  RunConflict,
  StorageError,
  Store,
} from '../src/index.ts'
import { Client, describeDefinition, task, workflow } from '../src/index.ts'
import { deployment, serve } from './typed-support.ts'

const Order = Schema.Struct({
  id: Schema.String,
  tenant: Schema.String,
  // Text where it is stored, a number wherever code sees it.
  cents: Schema.NumberFromString,
})
const Receipt = Schema.Struct({
  id: Schema.String,
  cents: Schema.NumberFromString,
})

type Order = typeof Order.Type

const order = (id: string, cents = 1200): Order => ({
  id,
  tenant: 'acme',
  cents,
})

/** A task and a workflow of one activity, with every start builder declared. */
function declare(builders: { readonly throwing?: boolean } = {}) {
  const pay = (input: Order) =>
    Effect.succeed({ id: input.id, cents: input.cents })
  const io = { pool: 'test', input: Order, output: Receipt }
  const start = {
    tags: (input: Order) => {
      if (builders.throwing) throw new Error('bad tags')
      return { tenant: input.tenant }
    },
    idempotency: (input: Order) => ['pay', input.id],
    unique: {
      key: (input: Order) => ['tenant', input.tenant],
      scope: 'all',
      behavior: 'join',
    },
  } as const

  const Pay = task({ ...io, ...start, name: 'pay', handler: pay })
  const Checkout = workflow(
    { ...io, ...start, name: 'checkout' },
    function* (w) {
      return yield* w.activity('pay', {
        input: Order,
        output: Receipt,
        from: w.input,
        handler: pay,
      })
    },
  )
  const Plain = workflow({ ...io, name: 'plain' }, function* (w) {
    return yield* w.task('pay', Pay, { input: w.input })
  })

  return { Pay, Checkout, Plain }
}

describe('start', () => {
  it.effect(
    'stores the encoded input and answers with the decoded run, for a workflow and a task',
    () => {
      const { Pay, Plain } = declare()
      const { provide, inspect } = deployment()

      return provide(
        Effect.gen(function* () {
          const flow = yield* Client.start(Plain, order('o-1'))
          expectTypeOf(flow).toEqualTypeOf<
            DecodedRun<Order, { readonly id: string; readonly cents: number }>
          >()
          expect(flow).toMatchObject({
            kind: 'workflow',
            name: 'plain',
            status: 'queued',
            input: order('o-1'),
            graphHash: describeDefinition(Plain).graphHash,
          })
          expect(flow).not.toHaveProperty('output')
          expect((yield* Client.get(flow.id))!.run.input).toStrictEqual({
            id: 'o-1',
            tenant: 'acme',
            cents: '1200',
          })

          const job = yield* Client.start(Pay, order('o-2'), {
            unique: { key: ['other'] },
          })
          expect(job).toMatchObject({ kind: 'task', name: 'pay' })
          // A task run is its first attempt: nothing coordinates it.
          expect(inspect.queue().map(({ command }) => command)).toMatchObject([
            { kind: 'continueRun', runId: flow.id },
            {
              kind: 'runTask',
              runId: job.id,
              input: { id: 'o-2', tenant: 'acme', cents: '1200' },
            },
          ])
        }),
      )
    },
  )

  it.effect(
    'writes the run, what starts it and its definitions in one commit',
    () => {
      const { Checkout } = declare()
      const commits: Mutation[] = []
      const { provide } = deployment({
        beforeCommit: (mutation) => commits.push(mutation),
      })

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Checkout, order('o-1'))

          expect(commits).toHaveLength(1)
          expect(commits[0]).toMatchObject({
            runs: [{ id: run.id }],
            enqueue: [{ command: { kind: 'continueRun', runId: run.id } }],
            definitions: [
              { key: `graph:${run.graphHash}`, value: { name: 'checkout' } },
            ],
          })
          expect(commits[0]!.keys).toHaveLength(2)
        }),
      )
    },
  )

  it.effect(
    "applies the declaration's builders to the decoded input, and lets options replace each",
    () => {
      const { Checkout } = declare()
      const { provide } = deployment()

      return provide(
        Effect.gen(function* () {
          const built = yield* Client.start(Checkout, order('o-1'))
          expect(built).toMatchObject({
            tags: { tenant: 'acme' },
            idempotencyKey: ['pay', 'o-1'],
            unique: { key: ['tenant', 'acme'], scope: 'all', behavior: 'join' },
          })

          const given = yield* Client.start(Checkout, order('o-1'), {
            tags: { source: 'import' },
            idempotencyKey: ['manual', 1],
            unique: { key: ['manual'] },
          })
          expect(given.id).not.toBe(built.id)
          expect(given).toMatchObject({
            tags: { source: 'import' },
            idempotencyKey: ['manual', 1],
            unique: { key: ['manual'], scope: 'active', behavior: 'reject' },
          })
        }),
      )
    },
  )

  it.effect(
    'answers a join with the completed run and its decoded output',
    () => {
      const { Checkout } = declare()
      const { provide, inspect } = deployment()

      return provide(
        Effect.gen(function* () {
          const first = yield* Client.start(Checkout, order('o-1', 250))
          yield* serve({ workflows: [Checkout] })

          // Another order of the tenant: the declared key joins, whatever the
          // input, and the `all` scope keeps the key after the run ended.
          const joined = yield* Client.start(Checkout, order('o-2'), {
            idempotencyKey: ['other'],
          })
          expect(joined).toMatchObject({
            id: first.id,
            status: 'completed',
            input: order('o-1', 250),
            output: { id: 'o-1', cents: 250 },
          })
          expect(inspect.runs()).toHaveLength(1)
        }),
      )
    },
  )

  it.effect('delays what starts the run, which exists at once', () => {
    const { Plain } = declare()
    const { provide, inspect } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Plain, order('o-1'), {
          startAt: 60_000,
        })
        yield* serve({ workflows: [Plain] }, 30_000)

        expect((yield* Client.get(run.id))!.run.status).toBe('queued')
        expect(inspect.queue()).toMatchObject([
          { availableAt: 60_000, deliveries: 0 },
        ])
      }),
    )
  })

  it.effect(
    'dies on an input its schema refuses and on a builder that throws, writing nothing',
    () => {
      const { Checkout } = declare()
      const throwing = declare({ throwing: true })
      const { provide, inspect } = deployment()
      const defect = <A, E>(effect: Effect.Effect<A, E, Store>) =>
        Effect.map(Effect.exit(effect), (exit) =>
          Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
        )

      return provide(
        Effect.gen(function* () {
          const invalid = yield* defect(
            Client.start(Checkout, { ...order('o-1'), cents: 'many' as never }),
          )
          expect(invalid).toMatchObject({
            message: 'Invalid workflow input [checkout]',
          })
          // Not a failure a caller is asked to handle.
          expect(
            yield* Effect.exit(
              Effect.catch(
                Client.start(throwing.Pay, order('o-1')),
                () => Effect.void,
              ),
            ),
          ).toSatisfy(Exit.isFailure)
          expect(
            yield* defect(Client.start(throwing.Pay, order('o-1'))),
          ).toMatchObject({ message: 'bad tags' })

          expect(inspect.runs()).toHaveLength(0)
          expect(inspect.definitions().size).toBe(0)
        }),
      )
    },
  )
})

describe('errors', () => {
  it.effect('are tagged, and carry what a caller acts on', () => {
    const { Checkout, Pay } = declare()
    const Reshaped = workflow(
      {
        name: 'pinned',
        revision: 'v1',
        pool: 'test',
        input: Order,
        output: Receipt,
      },
      function* (w) {
        return yield* w.task(
          'pay',
          task({
            name: 'pinned.pay',
            revision: 'v1',
            pool: 'test',
            input: Order,
            output: Receipt,
            handler: (input) => Effect.succeed(input),
          }),
          { input: w.input },
        )
      },
    )
    const Pinned = workflow(
      {
        name: 'pinned',
        revision: 'v1',
        pool: 'test',
        input: Order,
        output: Receipt,
      },
      function* (w) {
        return yield* w.activity('pay', {
          input: Order,
          output: Receipt,
          from: w.input,
          handler: (input) => Effect.succeed(input),
        })
      },
    )
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const first = yield* Client.start(Checkout, order('o-1'))

        const replayed = Client.start(Checkout, order('o-1', 1))
        expectTypeOf(replayed).toEqualTypeOf<
          Effect.Effect<
            DecodedRun<Order, { readonly id: string; readonly cents: number }>,
            | DefinitionConflict
            | IdempotencyConflict
            | RunConflict
            | StorageError,
            Store
          >
        >()
        // The same key for another input.
        expect(
          yield* replayed.pipe(
            Effect.catchTag('IdempotencyConflict', (error) =>
              Effect.succeed(error),
            ),
          ),
        ).toMatchObject({ name: 'checkout', runId: first.id })

        // The tenant's key is held, and this start does not ask to join.
        const held = yield* Client.start(Pay, order('o-9'), {
          unique: { key: ['tenant', 'acme'], scope: 'all' },
        }).pipe(
          Effect.catchTag('RunConflict', (error) => Effect.succeed(error)),
        )
        expect(held).toMatchObject({
          _tag: 'RunConflict',
          runId: first.id,
          status: 'queued',
          key: ['tenant', 'acme'],
          scope: 'all',
        })
        expect(held).not.toHaveProperty('holder')

        yield* Client.start(Pinned, order('o-3'))
        expect(
          yield* Client.start(Reshaped, order('o-4')).pipe(
            Effect.catchTag('DefinitionConflict', (error) =>
              Effect.succeed(error.message),
            ),
          ),
        ).toContain('workflow [pinned@v1] is already saved')
      }),
    )
  })
})

describe('reads and cancel', () => {
  it.effect('answer undefined for a run that does not exist', () => {
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        expect(yield* Client.get('run-0')).toBeUndefined()
        expect(yield* Client.inspect('run-0')).toBeUndefined()
        expect(yield* Client.cancel('run-0')).toBeUndefined()
        expect(
          yield* Client.getDefinition({
            kind: 'workflow',
            name: 'nothing',
            revision: 'v1',
          }),
        ).toBeUndefined()
      }),
    )
  })

  it.effect('give a run with everything it owns, as stored', () => {
    const { Plain } = declare()
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Plain, order('o-1', 75))
        yield* serve({ workflows: [Plain], tasks: Plain.tasks })

        const records = (yield* Client.get(run.id))!
        expect(records.run).toMatchObject({
          status: 'completed',
          output: { id: 'o-1', cents: '75' },
        })
        expect(records.nodes).toMatchObject([
          { name: 'pay', kind: 'task', output: { id: 'o-1', cents: '75' } },
        ])
        expect(records.children).toMatchObject([
          { nodeName: 'pay', status: 'completed' },
        ])

        const { detail } = (yield* Client.inspect(run.id))!
        expect(detail.childRuns).toMatchObject([
          { id: records.children[0]!.childRunId, kind: 'task', name: 'pay' },
        ])
      }),
    )
  })

  it.effect('cancel a run through its next pass', () => {
    const { Plain } = declare()
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Plain, order('o-1'))
        expect(yield* Client.cancel(run.id)).toMatchObject({
          id: run.id,
          status: 'cancelling',
        })

        yield* serve({ workflows: [Plain] })
        expect((yield* Client.get(run.id))!.run.status).toBe('cancelled')
      }),
    )
  })
})
