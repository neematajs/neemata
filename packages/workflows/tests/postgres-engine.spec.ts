import type { Vitest } from '@effect/vitest'
import type * as Scope from 'effect/Scope'
import { describe, expect, layer } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'

import type { AnySchedule } from '../src/index.ts'
import {
  Client,
  describeDefinition,
  RunBusy,
  schedule,
  Store,
  Worker,
  workflow,
} from '../src/index.ts'
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
import { pglite, postgres, POSTGRES_URL, provided } from './postgres-support.ts'

/**
 * The documented workflows, run by the real workers on the PostgreSQL store.
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
  {
    pollMs,
    count = 1,
    schedules,
  }: {
    readonly pollMs: number
    readonly count?: number
    readonly schedules?: readonly AnySchedule[]
  },
  { provide } = services(),
) =>
  Effect.gen(function* () {
    for (let worker = 0; worker < count; worker++) {
      yield* Effect.forkScoped(
        Worker.coordinator({
          workflows: served.workflows,
          pollMs,
          concurrency: 4,
          ...(schedules ? { schedules, scheduling: { everyMs: pollMs } } : {}),
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

const queued = Effect.flatMap(Store, (store) =>
  store.claim({
    lanes: [{ kind: 'continueRun', routes: [{ name: Billing.name }] }],
    limit: 10,
    leaseMs: 1_000,
  }),
)

function engine(real: boolean) {
  return (it: {
    readonly effect: Vitest.Tester<SqlClient.SqlClient | Scope.Scope>
  }) => {
    // Each test has a store of its own over emptied tables.
    const test = <A, E>(
      name: string,
      body: Effect.Effect<A, E, Store | SqlClient.SqlClient | Scope.Scope>,
    ) => it.effect(name, () => Effect.provide(body, provided()))

    test(
      'runs billing: a task, a branch, a child workflow and a service',
      Effect.gen(function* () {
        const handlers = services()
        yield* work({ pollMs: 50 }, handlers)
        const manual = yield* Client.start(Billing, order('o-1'))
        const automatic = yield* Client.start(
          Billing,
          order('o-2', 'automatic'),
        )

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
      "reads a map's children in index order, past ten items",
      Effect.gen(function* () {
        yield* work({ pollMs: 50 })
        const lines = Array.from({ length: 12 }, (_, index) => ({
          sku: `s${index}`,
          quantity: 1,
        }))
        const run = yield* Client.start(Fulfillment, {
          id: 'f-12',
          gift: false,
          lines,
        })
        expect((yield* ended(run.id)).status).toBe('completed')

        // Stored under keys that sort `item:1, item:10, item:11, item:2`.
        const items = lines.map((_, index) => `item:${index}`)
        const keys = (
          children: readonly {
            readonly nodeName: string
            readonly childKey: string
          }[],
        ) =>
          children
            .filter(({ nodeName }) => nodeName === 'reserve')
            .map(({ childKey }) => childKey)
        const records = (yield* Client.get(run.id))!
        expect(keys(records.children)).toStrictEqual(items)
        expect(keys((yield* Client.getDetail(run.id))!.children)).toStrictEqual(
          items,
        )
        const names = records.children.map(({ nodeName }) => nodeName)
        expect(names).toStrictEqual(names.toSorted())
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
        // One Ship run per line, each a row of its own under the parent.
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
      }),
    )

    test(
      'a caller transaction that rolls back takes the start with it',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        let started: string | undefined
        const exit = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              const run = yield* Client.start(Billing, order('o-1'))
              started = run.id
              // The caller sees its own uncommitted run.
              expect((yield* Client.get(run.id))?.run.status).toBe('queued')
              return yield* Effect.fail('changed my mind' as const)
            }),
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Client.get(started!)).toBeUndefined()
        expect(yield* queued).toEqual([])

        // Committed, the same start is there with its command.
        const run = yield* sql.withTransaction(
          Client.start(Billing, order('o-1')),
        )
        expect((yield* Client.get(run.id))?.run.status).toBe('queued')
        expect(yield* queued).toMatchObject([{ command: { runId: run.id } }])
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
      'a start inside a caller transaction is worked once it commits',
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* work({ pollMs: 120_000 })
        yield* Effect.sleep('300 millis')
        const run = yield* sql.withTransaction(
          Effect.gen(function* () {
            const run = yield* Client.start(Billing, order('o-1'))
            // The hint is the commit's: workers hear nothing before it.
            yield* Effect.sleep('200 millis')
            expect((yield* Client.get(run.id))?.run.status).toBe('queued')
            return run
          }),
        )

        expect(yield* ended(run.id)).toMatchObject({ status: 'completed' })
      }),
    )

    const scheduled = (name: string, options: Partial<AnySchedule> = {}) =>
      schedule({
        name,
        runnable: Billing,
        input: order(name),
        every: '1h',
        ...options,
      })
    const counts = Effect.flatMap(SqlClient.SqlClient, (sql) =>
      Effect.map(
        sql.unsafe<Record<string, number>>(
          `SELECT
            (SELECT count(*)::int FROM workflow_runs) AS runs,
            (SELECT count(*)::int FROM workflow_nodes) AS nodes,
            (SELECT count(*)::int FROM workflow_node_children) AS children,
            (SELECT count(*)::int FROM workflow_attempts) AS attempts,
            (SELECT count(*)::int FROM workflow_keys) AS keys,
            (SELECT count(*)::int FROM workflow_commands) AS commands,
            (SELECT count(*)::int FROM workflow_definitions) AS definitions`,
        ),
        ([row]) => row!,
      ),
    )

    test(
      'keeps a schedule as it is declared, changed and removed',
      Effect.gen(function* () {
        const nightly = scheduled('nightly', {
          every: undefined,
          cron: '0 3 * * *',
          timeZone: 'Europe/Paris',
          tags: { tenant: 'a' },
        })
        const [stored] = yield* Worker.reconcileSchedules([
          nightly,
          scheduled('hourly', { enabled: false }),
        ])
        expect(stored).toEqual({
          name: 'nightly',
          runnable: { kind: 'workflow', name: 'billing' },
          graphHash: describeDefinition(Billing).graphHash,
          // As the codec stores it.
          input: { id: 'nightly', mode: 'manual', cents: '500' },
          tags: { tenant: 'a' },
          cron: '0 3 * * *',
          timeZone: 'Europe/Paris',
          enabled: true,
          nextRunAt: expect.any(Number),
          version: 1,
          createdAt: expect.any(Number),
          updatedAt: stored!.createdAt,
        })
        expect(stored!.nextRunAt).toBeGreaterThan(stored!.createdAt)
        const [hourly] = yield* Client.schedules.list()
        expect(yield* Client.schedules.list()).toEqual([
          { ...hourly, name: 'hourly', everyMs: 3_600_000, enabled: false },
          stored,
        ])

        expect(
          yield* Client.schedules.setEnabled('nightly', false),
        ).toMatchObject({ enabled: false, version: 2 })
        const manual = yield* Client.schedules.trigger('nightly')
        expect(manual).toMatchObject({
          name: 'billing',
          tags: { tenant: 'a', schedule: 'nightly' },
        })

        yield* Worker.reconcileSchedules([nightly])
        expect(yield* Client.schedules.list()).toEqual([
          { ...stored, version: 3, updatedAt: expect.any(Number) },
        ])
      }),
    )

    test(
      'leaves one declared set when schedules are reconciled at once',
      Effect.gen(function* () {
        const sets = Array.from({ length: 6 }, (_, index) => [
          scheduled(`${index}-a`),
          scheduled(`${index}-b`),
        ])
        yield* Effect.all(sets.map(Worker.reconcileSchedules), {
          concurrency: 'unbounded',
        })
        expect(sets.map((set) => set.map(({ name }) => name))).toContainEqual(
          (yield* Client.schedules.list()).map(({ name }) => name),
        )
      }),
    )

    test(
      'fires a slot once, however many schedulers find it due',
      Effect.gen(function* () {
        yield* Worker.reconcileSchedules([
          scheduled('s', { immediately: true }),
        ])
        const fired = yield* Effect.all(
          Array.from({ length: 8 }, () => Worker.fireSchedules()),
          { concurrency: 'unbounded' },
        )
        expect(fired.reduce((sum, { fired }) => sum + fired, 0)).toBe(1)
        const { runs } = yield* Client.list({ tags: { schedule: 's' } })
        expect(runs).toHaveLength(1)
        const [stored] = yield* Client.schedules.list()
        expect(runs[0]!.idempotencyKey).toEqual([
          '$schedule',
          's',
          stored!.lastSlotAt,
        ])
        expect(stored!.nextRunAt).toBe(stored!.lastSlotAt! + 3_600_000)
      }),
    )

    test(
      'coordinators reconcile their schedules, fire them and work the runs',
      Effect.gen(function* () {
        yield* Worker.reconcileSchedules([scheduled('stale')])
        yield* work({
          pollMs: 20,
          count: 3,
          schedules: [scheduled('s', { immediately: true })],
        })
        const fired = Effect.gen(function* () {
          for (;;) {
            const { runs } = yield* Client.list({ tags: { schedule: 's' } })
            if (runs.length > 0) return runs
            yield* Effect.sleep('20 millis')
          }
        }).pipe(Effect.timeout('30 seconds'), Effect.orDie)

        const [run] = yield* fired
        expect(yield* ended(run!.id)).toMatchObject({
          status: 'completed',
          output: { order: 's', paidBy: 'finance' },
        })
        // Every coordinator kept looking: none fired the slot again.
        yield* Effect.sleep('300 millis')
        expect(yield* fired).toHaveLength(1)
        expect(
          (yield* Client.schedules.list()).map(({ name }) => name),
        ).toEqual(['s'])
      }),
    )

    test(
      'deletes a family with all it left, and keeps what is shared',
      Effect.gen(function* () {
        yield* work({ pollMs: 20 })
        const [gone, kept] = [
          yield* Client.start(Billing, order('o-1'), {
            idempotencyKey: ['o-1'],
            unique: { key: ['customer', 1], scope: 'all' },
          }),
          yield* Client.start(Billing, order('o-2')),
        ]
        yield* ended(gone.id)
        yield* ended(kept.id)
        const [, child] = yield* Client.getFamily(gone.id)
        const before = yield* counts
        expect(before.keys).toBe(2)

        expect(
          yield* Effect.flip(Client.deleteRun(child!.run.id)),
        ).toMatchObject({ _tag: 'RunNotRoot' })
        expect(yield* Client.deleteRun(gone.id)).toEqual({ deleted: true })

        // Two families of one shape: half of everything is left.
        expect(yield* counts).toEqual({
          runs: before.runs / 2,
          nodes: before.nodes / 2,
          children: before.children / 2,
          attempts: before.attempts / 2,
          keys: 0,
          commands: 0,
          definitions: before.definitions,
        })
        expect(yield* Client.getFamily(gone.id)).toEqual([])
        expect(yield* Client.getFamily(kept.id)).toHaveLength(before.runs / 2)
        expect(yield* Client.deleteRun(gone.id)).toEqual({ deleted: false })
        expect(yield* Client.deleteRun('no-run')).toEqual({ deleted: false })
        // The keys are free: the same start makes a new run.
        const again = yield* Client.start(Billing, order('o-1'), {
          idempotencyKey: ['o-1'],
          unique: { key: ['customer', 1], scope: 'all' },
        })
        expect(again.id).not.toBe(gone.id)
      }),
    )

    test(
      'prunes what ended a batch at a time, and keeps what is in flight',
      Effect.gen(function* () {
        const live = yield* Client.start(Billing, order('live'), {
          startAt: Date.now() + 3_600_000,
        })
        yield* work({ pollMs: 20 })
        const done = yield* Effect.all(
          Array.from({ length: 5 }, (_, index) =>
            Client.start(Billing, order(`o-${index}`)),
          ),
        )
        for (const run of done) yield* ended(run.id)
        const olderThan = Date.now() + 60_000

        expect(yield* Effect.flip(Client.deleteRun(live.id))).toEqual(
          new RunBusy({ runId: live.id, busyRunId: live.id }),
        )
        expect(
          yield* Client.pruneRuns({ olderThan: done[0]!.createdAt }),
        ).toEqual({ deleted: 0 })
        expect(
          yield* Client.pruneRuns({ olderThan, statuses: ['failed'] }),
        ).toEqual({ deleted: 0 })
        expect(yield* Client.pruneRuns({ olderThan, batchSize: 2 })).toEqual({
          deleted: 5,
        })
        expect((yield* Client.list()).runs.map(({ id }) => id)).toEqual([
          live.id,
        ])
        expect(yield* counts).toMatchObject({ runs: 1, nodes: 0, commands: 1 })
      }),
    )
    test(
      "a start refused inside a caller's transaction leaves it to go on and commit",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* Effect.acquireRelease(
          sql.unsafe('CREATE TABLE caller_notes (note text PRIMARY KEY)'),
          () => Effect.orDie(sql.unsafe('DROP TABLE caller_notes')),
        )
        const note = (text: string) =>
          sql.unsafe('INSERT INTO caller_notes VALUES ($1)', [text])
        const pinned = (step: string) =>
          workflow(
            {
              name: 'pinned',
              revision: 'v1',
              pool: 'billing',
              input: Schema.String,
              output: Schema.String,
            },
            function* (w) {
              return yield* w.activity(step, {
                input: Schema.String,
                output: Schema.String,
                from: w.input,
                handler: (text) => Effect.succeed(text),
              })
            },
          )
        const once = { idempotencyKey: ['order', 1] }
        const alone = { unique: { key: ['tenant', 'acme'] } }
        yield* Client.start(Billing, order('o-1'), once)
        yield* Client.start(Billing, order('o-2'), alone)
        yield* Client.start(pinned('first'), 'p-1')
        const refusals: Record<
          string,
          Effect.Effect<unknown, { readonly _tag: string }, Store>
        > = {
          IdempotencyConflict: Client.start(Billing, order('o-3'), once),
          RunConflict: Client.start(Billing, order('o-4'), alone),
          DefinitionConflict: Client.start(pinned('reshaped'), 'p-2'),
        }

        const after: string[] = []
        for (const [tag, refused] of Object.entries(refusals)) {
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* note(`before ${tag}`)
              expect((yield* Effect.flip(refused))._tag).toBe(tag)
              // Still a transaction: it writes, starts and reads its own.
              yield* note(`after ${tag}`)
              const run = yield* Client.start(Billing, order(`ok-${tag}`))
              expect((yield* Client.get(run.id))?.run.status).toBe('queued')
              after.push(run.id)
            }),
          )
        }

        // All of it committed, on both sides of each refusal.
        expect(
          yield* sql.unsafe('SELECT note FROM caller_notes ORDER BY note'),
        ).toEqual(
          Object.keys(refusals)
            .flatMap((tag) => [`after ${tag}`, `before ${tag}`])
            .toSorted()
            .map((note) => ({ note })),
        )
        for (const runId of after) {
          expect((yield* Client.get(runId))?.run.status).toBe('queued')
        }
        expect((yield* Client.list()).runs).toHaveLength(6)
      }),
    )

    test(
      'an id in another spelling is the id of no run, whatever is asked of it',
      Effect.gen(function* () {
        const run = yield* Client.start(Billing, order('o-1'))
        const other = run.id.toUpperCase()

        expect(yield* Client.get(other)).toBeUndefined()
        expect(yield* Client.cancel(other)).toBeUndefined()
        expect((yield* Effect.flip(Client.retry(other)))._tag).toBe(
          'RunNotFound',
        )
        expect(yield* Client.deleteRun(other)).toEqual({ deleted: false })
        expect((yield* Client.get(run.id))?.run).toMatchObject({
          status: 'queued',
          version: 1,
        })
      }),
    )

    test(
      'keeps an interval written in fractions of a second',
      Effect.gen(function* () {
        const [stored] = yield* Worker.reconcileSchedules([
          scheduled('fine', { every: '1.001s' }),
        ])
        expect(stored).toMatchObject({ name: 'fine', everyMs: 1001 })
        expect(yield* Client.schedules.list()).toEqual([stored])
      }),
    )

    if (!real) return

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

        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql.unsafe<{ runs: number }>(
          'SELECT count(*)::int AS runs FROM workflow_runs',
        )
        expect(rows[0]!.runs).toBe(2)
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
        const sql = yield* SqlClient.SqlClient
        const deadlocks = sql.unsafe<{ deadlocks: number }>(
          `SELECT deadlocks::int FROM pg_stat_database
           WHERE datname = current_database()`,
        )
        const [before] = yield* deadlocks
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
        // reads its children: neither order of the two may lose a wake.
        for (const run of runs) {
          expect(yield* ended(run.id)).toMatchObject({
            status: 'completed',
            output: { units: 12, note: '12 units' },
          })
        }
        // Guards are taken in one order, so the two never wait on each
        // other. The count is the database's, and is reported late.
        yield* Effect.sleep('1500 millis')
        expect(yield* deadlocks).toEqual([before])
      }),
    )

    test(
      "a caller's open transaction holds up no other start, nor any run, of the definitions it started",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const Pinned = workflow(
          {
            name: 'pinned',
            revision: 'v1',
            pool: 'billing',
            input: Schema.String,
            output: Schema.String,
          },
          function* (w) {
            return yield* w.activity('echo', {
              input: Schema.String,
              output: Schema.String,
              from: w.input,
              handler: (text) => Effect.succeed(text),
            })
          },
        )
        // Saved and committed: from now on every start and pass reads them.
        const committed = yield* Client.start(Pinned, 'committed')
        yield* Client.start(Billing, order('o-0'))

        const started = yield* Deferred.make<void>()
        const decide = yield* Deferred.make<void>()
        const open = yield* Effect.forkScoped(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* Client.start(Pinned, 'open')
              yield* Client.start(Billing, order('o-open'))
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(decide)
            }),
          ),
        )
        yield* Deferred.await(started)

        // On other connections, while the caller has not decided.
        const meanwhile = Effect.gen(function* () {
          yield* Client.start(Pinned, 'beside')
          yield* Client.start(Billing, order('o-beside'))
          yield* Effect.forkScoped(
            Worker.coordinator({ workflows: [Pinned], pollMs: 20 }),
          )
          yield* Effect.forkScoped(
            Worker.execution({ workflows: [Pinned], pollMs: 20 }),
          )
          return yield* ended(committed.id)
        })
        // Well within the test's own time: what waits for the caller fails.
        expect(
          yield* meanwhile.pipe(Effect.timeout('3 seconds')),
        ).toMatchObject({ status: 'completed', output: 'committed' })

        yield* Deferred.succeed(decide, undefined)
        yield* Fiber.join(open)
        expect((yield* Client.list({ name: 'pinned' })).runs).toHaveLength(3)
      }),
    )
  }
}

const options = { excludeTestServices: true, timeout: '60 seconds' } as const

layer(pglite, options)('the engine on PGlite', engine(false))

describe.skipIf(!POSTGRES_URL)('the engine on PostgreSQL', () => {
  layer(postgres(POSTGRES_URL!), options)(engine(true))
})
