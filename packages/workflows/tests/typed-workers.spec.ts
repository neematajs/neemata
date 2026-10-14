import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type {
  CleanupTimeout,
  DefinitionConflict,
  ServedWorkflow,
  StorageError,
  Store,
  Task,
} from '../src/index.ts'
import { Client, schedule, task, Worker, workflow } from '../src/index.ts'
import {
  Billing,
  ChargeCard,
  CreateInvoice,
  ManualBilling,
  Payments,
  RecordPayment,
  RequestApproval,
} from './fixtures/billing.ts'
import {
  Carriers,
  Fulfillment,
  Reserve,
  Screen,
  Ship,
} from './fixtures/fulfillment.ts'
import { elapse, idle } from './support.ts'
import { deployment } from './typed-support.ts'

const billing = {
  workflows: [Billing, ManualBilling],
  tasks: [CreateInvoice, ChargeCard, RequestApproval, RecordPayment],
}
const fulfillment = { workflows: [Fulfillment, Ship], tasks: [Screen, Reserve] }

const options = { pollMs: 1_000, concurrency: 4 }

const payments = Effect.provideService(Payments, {
  charge: (invoice, cents) => Effect.succeed(`card for ${invoice}: ${cents}`),
})
const carriers = Effect.provideService(Carriers, {
  book: (order, sku) => Effect.succeed(`trk-${order}-${sku}`),
})

describe('the services a worker requires', () => {
  it('are those of the handlers its pool runs', () => {
    // No task or workflow of the `billing` pool has a handler that needs any.
    expectTypeOf(
      Worker.execution({ ...billing, pool: 'billing' }),
    ).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store>
    >()
    expectTypeOf(
      Worker.execution({ ...billing, pool: 'payments' }),
    ).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store | Payments>
    >()

    // An activity runs on its workflow's pool: `label` is Ship's, not
    // Fulfillment's, though only Fulfillment starts it.
    expectTypeOf(
      Worker.execution({ ...fulfillment, pool: 'fulfillment' }),
    ).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store>
    >()
    expectTypeOf(
      Worker.execution({ ...fulfillment, pool: 'shipping' }),
    ).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store | Carriers>
    >()
  })

  it('are those of every handler when the worker names no pool', () => {
    expectTypeOf(Worker.execution(billing)).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store | Payments>
    >()
    expectTypeOf(
      Worker.execution({
        workflows: [...billing.workflows, ...fulfillment.workflows],
        tasks: [...billing.tasks, ...fulfillment.tasks],
      }),
    ).toEqualTypeOf<
      Effect.Effect<
        never,
        CleanupTimeout | StorageError,
        Store | Payments | Carriers
      >
    >()
  })

  it('count every declaration for a pool the types cannot tell', () => {
    const pool: string = 'payments'
    expectTypeOf(Worker.execution({ ...billing, pool })).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store | Payments>
    >()

    const erased: {
      workflows: readonly ServedWorkflow<string, any, any, Carriers>[]
      // Not `AnyTask`: its services are `any`, which would stand in for
      // Carriers and for anything else, and so prove nothing.
      tasks: readonly Task<string, any, any, never>[]
    } = { workflows: [Ship], tasks: [] }
    expectTypeOf(
      Worker.execution({ ...erased, pool: 'payments' }),
    ).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store | Carriers>
    >()
  })

  it('leave out the scope of an attempt, which the worker gives a handler', () => {
    const Scoped = task({
      name: 'scoped',
      pool: 'io',
      input: Schema.String,
      output: Schema.String,
      handler: (text) =>
        Effect.acquireRelease(Effect.succeed(text), () => Effect.void),
    })
    expectTypeOf(Worker.execution({ tasks: [Scoped] })).toEqualTypeOf<
      Effect.Effect<never, CleanupTimeout | StorageError, Store>
    >()
  })

  it('must be provided before the worker can run', () => {
    const needsStore = (
      worker: Effect.Effect<
        never,
        CleanupTimeout | DefinitionConflict | StorageError,
        Store
      >,
    ) => worker

    needsStore(Worker.coordinator({ workflows: billing.workflows }))
    needsStore(Worker.execution({ ...billing, pool: 'billing' }))
    needsStore(payments(Worker.execution({ ...billing, pool: 'payments' })))
    // @ts-expect-error ChargeCard runs on `payments` and requires Payments.
    needsStore(Worker.execution({ ...billing, pool: 'payments' }))
    // @ts-expect-error Without a pool the worker runs ChargeCard too.
    needsStore(Worker.execution(billing))
    // @ts-expect-error Ship's activity runs on `shipping` and requires Carriers.
    needsStore(Worker.execution({ workflows: [Ship], pool: 'shipping' }))
    // @ts-expect-error Payments is not what Ship's activity requires.
    needsStore(payments(Worker.execution({ workflows: [Ship] })))
  })
})

describe('typed workers', () => {
  it.effect(
    'run billing through the client, each pool its own handlers',
    () => {
      const { provide, inspect } = deployment()
      const summary = { order: 'o-1', invoice: 'inv-o-1' }

      return provide(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            Worker.coordinator({ workflows: billing.workflows, ...options }),
          )
          yield* Effect.forkScoped(
            Worker.execution({ ...billing, pool: 'billing', ...options }),
          )
          const manual = yield* Client.start(Billing, {
            id: 'o-1',
            mode: 'manual',
            cents: 500,
          })
          const automatic = yield* Client.start(Billing, {
            id: 'o-2',
            mode: 'automatic',
            cents: 900,
          })
          yield* elapse(10_000)

          // Every handler of the manual case is of the `billing` pool.
          expect((yield* Client.get(manual.id))!.run).toMatchObject({
            status: 'completed',
            output: { ...summary, paidBy: 'finance' },
          })
          // ChargeCard is not: its attempt waits for a worker of its pool.
          expect((yield* Client.get(automatic.id))!.run.status).toBe('waiting')
          expect(inspect.queue()).toMatchObject([
            {
              command: { kind: 'runTask', name: 'billing.charge' },
              deliveries: 0,
            },
          ])

          yield* Effect.forkScoped(
            payments(
              Worker.execution({ ...billing, pool: 'payments', ...options }),
            ),
          )
          yield* elapse(10_000)
          expect((yield* Client.get(automatic.id))!.run).toMatchObject({
            status: 'completed',
            output: {
              order: 'o-2',
              invoice: 'inv-o-2',
              paidBy: 'card for inv-o-2: 900',
            },
          })
          expect(inspect.queue()).toHaveLength(0)
        }),
      )
    },
  )

  it.effect(
    'run fulfillment through the client, an activity on its workflow`s pool',
    () => {
      const { provide, inspect } = deployment()
      const worker = (pool: string) =>
        Worker.execution({ ...fulfillment, pool, ...options })

      return provide(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            Worker.coordinator({
              workflows: fulfillment.workflows,
              ...options,
            }),
          )
          for (const pool of ['fulfillment', 'risk', 'warehouse']) {
            yield* Effect.forkScoped(carriers(worker(pool)))
          }
          const run = yield* Client.start(Fulfillment, {
            id: 'o-7',
            gift: false,
            lines: [
              { sku: 'a', quantity: 2 },
              { sku: 'b', quantity: 3 },
            ],
          })
          yield* elapse(10_000)

          // Everything but the labels, which are activities of Ship.
          expect((yield* Client.get(run.id))!.run.status).toBe('waiting')
          expect(inspect.queue()).toMatchObject([
            { command: { kind: 'runAttempt', name: 'fulfillment.ship' } },
            { command: { kind: 'runAttempt', name: 'fulfillment.ship' } },
          ])

          yield* Effect.forkScoped(carriers(worker('shipping')))
          yield* elapse(10_000)
          const done = (yield* Client.get(run.id))!.run
          expect(done).toMatchObject({
            status: 'completed',
            output: {
              order: 'o-7',
              units: 5,
              risk: 'low',
              tracking: ['trk-o-7-a', 'trk-o-7-b'],
              note: '5 units',
            },
          })
          // The lines were stored through their schema: quantities as text.
          expect(done.input).toMatchObject({
            lines: [
              { sku: 'a', quantity: '2' },
              { sku: 'b', quantity: '3' },
            ],
          })
        }),
      )
    },
  )

  it.effect('serve what they are given and nothing it can start', () => {
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        // Billing alone: the manual case is a workflow nobody advances here.
        yield* Effect.forkScoped(
          Worker.coordinator({ workflows: [Billing], ...options }),
        )
        yield* Effect.forkScoped(
          payments(Worker.execution({ ...billing, ...options })),
        )
        const run = yield* Client.start(Billing, {
          id: 'o-1',
          mode: 'manual',
          cents: 1,
        })
        yield* elapse(10_000)

        const waiting = (yield* Client.inspect(run.id))!
        expect(waiting.detail.run.status).toBe('waiting')
        expect(waiting.detail.childRuns).toMatchObject([
          { name: 'billing.invoice', status: 'completed' },
          { name: 'billing.manual', status: 'queued' },
        ])

        yield* Effect.forkScoped(
          Worker.coordinator({ workflows: [ManualBilling], ...options }),
        )
        yield* idle
        yield* elapse(10_000)
        expect((yield* Client.get(run.id))!.run.status).toBe('completed')
      }),
    )
  })

  it('refuse two declarations of one revision', () => {
    const copy = () =>
      task({
        name: 'twice',
        pool: 'p',
        input: Schema.String,
        output: Schema.String,
        handler: (input) => Effect.succeed(input),
      })

    expect(() => Worker.execution({ tasks: [copy(), copy()] })).toThrow(
      'Task [twice] is registered twice for one revision',
    )
  })
})

describe('checking what a deployment serves', () => {
  const io = { pool: 'test', input: Schema.String, output: Schema.String }
  const family = (revision?: string, taskRevision = revision) => {
    const Leaf = task({
      ...io,
      name: 'registry.leaf',
      revision: taskRevision,
      handler: (input) => Effect.succeed(input),
    })
    const Child = workflow(
      { ...io, name: 'registry.child', revision },
      function* (w) {
        yield* w.parallel('both', {
          members: (p) => ({ leaf: p.task(Leaf, { input: w.input }) }),
        })
        return w.input
      },
    )
    const Parent = workflow(
      { ...io, name: 'registry.parent', revision },
      function* (w) {
        yield* w.mapWorkflow('each', Child, {
          item: Schema.String,
          items: Effect.succeed([]),
          input: (item) => Effect.succeed(item),
        })
        return yield* w.task('work', Leaf, { input: w.input })
      },
    )
    return { Leaf, Child, Parent }
  }

  it('accepts complete lists, several revisions of one name among them', () => {
    const generations = [family(), family('v1'), family('v2')]

    expect(() =>
      Worker.verify({
        workflows: generations.flatMap(({ Parent, Child }) => [Parent, Child]),
        tasks: generations.map(({ Leaf }) => Leaf),
        pools: ['test'],
      }),
    ).not.toThrow()
    expect(() => Worker.verify(billing)).not.toThrow()
    expect(() => Worker.verify(fulfillment)).not.toThrow()
    expect(() => Worker.verify({})).not.toThrow()
  })

  it('names the child workflows and tasks nothing serves', () => {
    const { Leaf, Child, Parent } = family()

    expect(() => Worker.verify({ workflows: [Parent], tasks: [Leaf] })).toThrow(
      'Workflows [registry.child] referenced by registered workflows are not registered',
    )
    expect(() => Worker.verify({ workflows: [Parent, Child] })).toThrow(
      'Tasks [registry.leaf] referenced by registered workflows are not registered',
    )
    // A case of a branch counts though a run may never take it.
    expect(() =>
      Worker.verify({
        workflows: [Billing, ManualBilling],
        tasks: [CreateInvoice, RequestApproval, RecordPayment],
      }),
    ).toThrow('Tasks [billing.charge] referenced')
  })

  it('takes a revision for what it is: another revision does not serve it', () => {
    const v1 = family('v1')
    const v2 = family('v2')

    expect(() =>
      Worker.verify({
        workflows: [v1.Parent, v1.Child, v2.Parent, v2.Child],
        tasks: [v2.Leaf],
      }),
    ).toThrow(
      'Tasks [registry.leaf@v1] referenced by registered workflows are not registered',
    )
  })

  it('refuses a declaration registered twice', () => {
    const v1 = family('v1')

    expect(() =>
      Worker.verify({
        workflows: [v1.Parent, v1.Child, family('v1').Parent],
        tasks: [v1.Leaf],
      }),
    ).toThrow(
      'Declarations [workflow:registry.parent@v1] are registered more than once',
    )
    expect(() => Worker.verify({ tasks: [v1.Leaf, v1.Leaf] })).toThrow(
      'Declarations [task:registry.leaf@v1] are registered more than once',
    )
  })

  it('refuses a reference to a copy of what is registered', () => {
    const one = family()
    const copy = family()

    // `one.Parent` starts `one.Child` and `one.Leaf` by route, and the
    // registered objects of those routes would read what it wrote.
    expect(() =>
      Worker.verify({
        workflows: [one.Parent, copy.Child],
        tasks: [one.Leaf],
      }),
    ).toThrow(
      'Declarations [registry.child, registry.leaf] exist as more than one object',
    )
  })

  it('holds what a schedule starts to what a step starts', () => {
    const { Leaf, Child, Parent } = family()
    const nightly = (runnable: typeof Leaf | typeof Child) =>
      schedule({ name: 'nightly', runnable, input: 'n', every: '1d' })

    expect(() =>
      Worker.verify({
        workflows: [Parent, Child],
        tasks: [Leaf],
        schedules: [nightly(Leaf), nightly(Child)],
        pools: ['test'],
      }),
    ).not.toThrow()
    // It fires whether or not any worker has code for its run.
    expect(() => Worker.verify({ schedules: [nightly(Leaf)] })).toThrow(
      'Tasks [registry.leaf] referenced by schedules are not registered',
    )
    expect(() =>
      Worker.verify({ tasks: [Leaf], schedules: [nightly(Child)] }),
    ).toThrow(
      'Workflows [registry.child] referenced by schedules are not registered',
    )
    expect(() =>
      Worker.verify({ tasks: [family().Leaf], schedules: [nightly(Leaf)] }),
    ).toThrow('Declarations [registry.leaf] exist as more than one object')
    expect(() =>
      Worker.verify({
        tasks: [Leaf],
        schedules: [nightly(Leaf)],
        pools: ['other'],
      }),
    ).toThrow('Execution pools [test] named by declarations are not declared')
  })

  it('refuses a pool the deployment runs no worker for', () => {
    expect(() =>
      Worker.verify({ ...billing, pools: ['billing', 'paymnets'] }),
    ).toThrow(
      'Execution pools [payments] named by declarations are not declared',
    )
    expect(() =>
      Worker.verify({ ...billing, pools: ['billing', 'payments'] }),
    ).not.toThrow()
  })
})
