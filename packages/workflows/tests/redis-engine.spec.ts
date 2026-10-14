import type { Vitest } from '@effect/vitest'
import type * as Redis from 'effect/persistence/Redis'
import type * as Scope from 'effect/Scope'
import { describe, expect, layer } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import { Client, Store, Worker } from '../src/index.ts'
import { isTerminal } from '../src/model.ts'
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
import { client, provided, SERVERS } from './redis-support.ts'

/**
 * The documented workflows, run by the real workers on the Redis store.
 * Nothing here is settled by hand: runs end because workers claim, run and
 * settle through the adapter.
 */

const served = {
  workflows: [Billing, ManualBilling, Fulfillment, Ship],
  tasks: [
    CreateInvoice,
    ChargeCard,
    RequestApproval,
    RecordPayment,
    Screen,
    Reserve,
  ],
}

/** The services the handlers need, and every charge made through them. */
function services() {
  const charged: string[] = []
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(Payments, {
        charge: (invoice) =>
          Effect.sync(() => {
            charged.push(invoice)
            return 'card'
          }),
      }),
      Effect.provideService(Carriers, {
        book: (order, sku) => Effect.succeed(`trk-${order}-${sku}`),
      }),
    )
  return { charged, provide }
}

/** Both worker roles, `count` of each, until the test's scope closes. */
const work = (
  { pollMs, count = 1 }: { readonly pollMs: number; readonly count?: number },
  { provide } = services(),
) =>
  Effect.gen(function* () {
    for (let worker = 0; worker < count; worker++) {
      yield* Effect.forkScoped(
        Worker.coordinator({
          workflows: served.workflows,
          pollMs,
          concurrency: 4,
        }),
      )
      yield* Effect.forkScoped(
        provide(Worker.execution({ ...served, pollMs, concurrency: 4 })),
      )
    }
  })

const ended = (runId: string) =>
  Effect.gen(function* () {
    for (;;) {
      const records = yield* Client.get(runId)
      if (records && isTerminal(records.run.status)) return records.run
      yield* Effect.sleep('20 millis')
    }
  }).pipe(Effect.timeout('30 seconds'), Effect.orDie)

const order = (id: string, mode: 'manual' | 'automatic' = 'manual') => ({
  id,
  mode,
  cents: 500,
})

function engine(it: {
  readonly effect: Vitest.Tester<Redis.Redis | Scope.Scope>
}) {
  // Each test has a store of its own, under a prefix of its own.
  const test = <A, E>(
    name: string,
    body: Effect.Effect<A, E, Store | Redis.Redis | Scope.Scope>,
  ) => it.effect(name, () => Effect.provide(body, provided()))

  test(
    'runs billing: a task, a branch, a child workflow and a service',
    Effect.gen(function* () {
      const handlers = services()
      yield* work({ pollMs: 50 }, handlers)
      const manual = yield* Client.start(Billing, order('o-1'))
      const automatic = yield* Client.start(Billing, order('o-2', 'automatic'))

      expect(yield* ended(manual.id)).toMatchObject({
        status: 'completed',
        output: { order: 'o-1', invoice: 'inv-o-1', paidBy: 'finance' },
      })
      expect(yield* ended(automatic.id)).toMatchObject({
        status: 'completed',
        output: { order: 'o-2', invoice: 'inv-o-2', paidBy: 'card' },
      })
      expect(handlers.charged).toEqual(['inv-o-2'])
    }),
  )

  test(
    'runs fulfillment: parallel members, both maps and a branch',
    Effect.gen(function* () {
      yield* work({ pollMs: 50 })
      const run = yield* Client.start(Fulfillment, {
        id: 'f-1',
        gift: true,
        lines: [
          { sku: 'a', quantity: 2 },
          { sku: 'b', quantity: 3 },
          { sku: 'c', quantity: 1 },
        ],
      })

      expect(yield* ended(run.id)).toMatchObject({
        status: 'completed',
        output: {
          order: 'f-1',
          units: 6,
          risk: 'low',
          tracking: ['trk-f-1-a', 'trk-f-1-b', 'trk-f-1-c'],
          note: 'gift receipt for f-1',
        },
      })
      // One Ship run per line, each a run of its own under the parent.
      const { children } = (yield* Client.get(run.id))!
      const ships = children.filter(({ nodeName }) => nodeName === 'ship')
      expect(ships).toHaveLength(3)
      for (const { childRunId } of ships) {
        expect((yield* Client.get(childRunId!))!.run).toMatchObject({
          status: 'completed',
          parentRunId: run.id,
          rootRunId: run.id,
        })
      }
      // Nothing is left to deliver, and nothing was set aside.
      const store = yield* Store
      expect(yield* store.dead({ limit: 10 })).toEqual({ items: [] })
      const family = yield* store.runs({
        limit: 100,
        filter: { rootRunId: run.id },
      })
      expect(yield* store.claimed(family.items.map(({ id }) => id))).toEqual([])
    }),
  )

  test(
    'hints wake idle workers: nothing here is found by polling',
    Effect.gen(function* () {
      yield* work({ pollMs: 120_000 })
      // Long enough for both workers to find nothing and go to sleep.
      yield* Effect.sleep('300 millis')
      const run = yield* Client.start(Billing, order('o-1'))

      expect(yield* ended(run.id)).toMatchObject({ status: 'completed' })
    }),
  )

  test(
    'concurrent starts with one unique key create one run',
    Effect.gen(function* () {
      const start = (behavior: 'reject' | 'join') =>
        Effect.all(
          Array.from({ length: 10 }, (_, index) =>
            Effect.exit(
              Client.start(Billing, order(`o-${index}`), {
                unique: { key: ['customer', behavior], behavior },
              }),
            ),
          ),
          { concurrency: 'unbounded' },
        )

      const rejected = yield* start('reject')
      const [winner, ...others] = rejected.filter(Exit.isSuccess)
      expect(others).toEqual([])
      for (const exit of rejected.filter(Exit.isFailure)) {
        expect(yield* Effect.flip(exit)).toMatchObject({
          _tag: 'RunConflict',
          runId: winner!.value.id,
        })
      }

      const joined = yield* start('join')
      expect(joined.every(Exit.isSuccess)).toBe(true)
      const ids = joined.flatMap((exit) =>
        Exit.isSuccess(exit) ? [exit.value.id] : [],
      )
      expect(new Set(ids).size).toBe(1)

      const store = yield* Store
      expect((yield* store.runs({ limit: 100 })).items).toHaveLength(2)
    }),
  )

  test(
    'workers racing for commands run every handler once',
    Effect.gen(function* () {
      const handlers = services()
      yield* work({ pollMs: 20, count: 3 }, handlers)
      const runs = yield* Effect.all(
        Array.from({ length: 16 }, (_, index) =>
          Client.start(Billing, order(`o-${index}`, 'automatic')),
        ),
        { concurrency: 'unbounded' },
      )

      for (const run of runs) {
        expect((yield* ended(run.id)).status).toBe('completed')
      }
      expect(handlers.charged.toSorted()).toEqual(
        runs.map((_, index) => `inv-o-${index}`).toSorted(),
      )
    }),
  )

  test(
    'children that finish while their parent is advanced lose nothing',
    Effect.gen(function* () {
      yield* work({ pollMs: 20, count: 3 })
      const lines = Array.from({ length: 12 }, (_, index) => ({
        sku: `s${index}`,
        quantity: 1,
      }))
      const runs = yield* Effect.all(
        Array.from({ length: 4 }, (_, index) =>
          Client.start(Fulfillment, { id: `f-${index}`, gift: false, lines }),
        ),
      )

      // Each child's last pass reads its parent while the parent's pass
      // reads its children: whichever commits second plans again on what
      // the first wrote, so neither order of the two may lose a wake.
      for (const run of runs) {
        expect(yield* ended(run.id)).toMatchObject({
          status: 'completed',
          output: { units: 12, note: '12 units' },
        })
      }
    }),
  )
}

const options = { excludeTestServices: true, timeout: '60 seconds' } as const

for (const [server, url] of SERVERS) {
  describe.skipIf(!url)(`the engine on ${server}`, () => {
    layer(client(url!), options)(engine)
  })
}
