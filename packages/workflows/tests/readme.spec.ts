// The examples of README.md, run as the guide prints them. Each `#region` is
// one example: the guide holds its text as it stands here, but for the import
// paths, which are the package's own there. Change the two together.
import { PgliteClient } from '@effect/sql-pglite'
import { describe, expect, expectTypeOf, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'

import type {
  CleanupTimeout,
  DefinitionConflict,
  StorageError,
  Store,
} from '../src/index.ts'
import type { RunDetail, RunInspection } from '../src/inspector.ts'
import {
  Client,
  decodeRun,
  durable,
  InMemory,
  schedule,
  task,
  Worker,
  workflow,
} from '../src/index.ts'
import {
  durableView,
  nodeUnits,
  renderWorkflowGraph,
  serializeWorkflowCatalog,
  serializeWorkflowGraph,
} from '../src/inspector.ts'
import * as Postgres from '../src/postgres/index.ts'
import * as PostgresPglite from '../src/postgres/pglite.ts'
import {
  Billing,
  ChargeCard,
  CreateInvoice,
  ManualBilling,
  Payments,
  RecordPayment,
  RequestApproval,
} from './fixtures/billing.ts'
import { deployment, serve } from './typed-support.ts'

// #region quickstart
const Greet = task({
  name: 'greet',
  pool: 'default',
  input: Schema.String,
  output: Schema.String,
  handler: (name) => Effect.succeed(`Hello, ${name}`),
})

const Welcome = workflow(
  {
    name: 'welcome',
    pool: 'default',
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({ greeting: Schema.String, length: Schema.Number }),
  },
  function* (w) {
    // A step that starts a run of the task.
    const greeting = yield* w.task('greet', Greet, {
      input: Effect.map(w.input, ({ name }) => name),
    })
    // A step declared in place, run on the workflow's pool.
    const length = yield* w.activity('measure', {
      input: Schema.String,
      output: Schema.Number,
      from: greeting,
      handler: (text) => Effect.succeed(text.length),
    })
    return Effect.all({ greeting, length })
  },
)

const quickstart = Effect.gen(function* () {
  // Workers run until they are interrupted: here, when the scope closes.
  yield* Effect.forkScoped(Worker.coordinator({ workflows: Welcome.workflows }))
  yield* Effect.forkScoped(
    Worker.execution({ workflows: Welcome.workflows, tasks: Welcome.tasks }),
  )

  const run = yield* Client.start(Welcome, { name: 'Ada' })
  // The stream ends with the status the run ends in.
  yield* Stream.runDrain(Client.watch(run.id))

  const records = yield* Client.get(run.id)
  return decodeRun(Welcome, records!.run).output
}).pipe(Effect.scoped, Effect.provide(InMemory.layer()))
// #endregion

// #region declaration
const Order = Schema.Struct({
  id: Schema.String,
  tenant: Schema.String,
  // Text where it is stored, a number wherever code sees it.
  cents: Schema.NumberFromString,
})
const Receipt = Schema.Struct({ id: Schema.String, reference: Schema.String })

/** The payment gateway; the worker supplies it. */
class Gateway extends Context.Service<
  Gateway,
  {
    readonly charge: (
      key: string,
      cents: number,
    ) => Effect.Effect<string, Error>
  }
>()('readme/Gateway') {}

const Charge = task({
  name: 'charge',
  pool: 'payments',
  input: Order,
  output: Receipt,
  retry: { attempts: 3, backoff: 'exponential', delay: '1s' },
  timeout: '30s',
  tags: (order) => ({ tenant: order.tenant }),
  idempotency: (order) => ['charge', order.id],
  unique: {
    key: (order) => ['tenant', order.tenant],
    scope: 'active',
    behavior: 'reject',
  },
  handler: (order, attempt) =>
    Effect.gen(function* () {
      const gateway = yield* Gateway
      // The same key for every attempt of this work, so the gateway charges
      // once however often the handler runs.
      const reference = yield* gateway.charge(
        attempt.idempotencyKey,
        order.cents,
      )
      return { id: order.id, reference }
    }),
})
// #endregion

// #region stop-reason
/** Where readers watch a reply as it is written; the worker supplies it. */
class Replies extends Context.Service<
  Replies,
  {
    readonly write: (key: string, prompt: string) => Effect.Effect<string>
    readonly end: (
      key: string,
      reason: 'cancelled' | 'timedOut',
    ) => Effect.Effect<void>
  }
>()('readme/Replies') {}

const Reply = task({
  name: 'reply',
  pool: 'chat',
  input: Schema.String,
  output: Schema.String,
  timeout: '2m',
  handler: (prompt, attempt) =>
    Effect.flatMap(Replies, (replies) =>
      replies.write(attempt.idempotencyKey, prompt).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            const reason = yield* attempt.stopReason
            // Otherwise left open for the delivery that takes the work over.
            if (reason === 'cancelled' || reason === 'timedOut') {
              yield* replies.end(attempt.idempotencyKey, reason)
            }
          }),
        ),
      ),
    ),
})
// #endregion

// #region start
/** Starts the charge of an order, or names the run its tenant is busy with. */
const admit = (order: typeof Order.Type) =>
  Client.start(Charge, order).pipe(
    Effect.map((run) => ({ started: run.id })),
    Effect.catchTag('RunConflict', ({ runId }) =>
      Effect.succeed({ busyWith: runId }),
    ),
  )
// #endregion

// #region retry
/**
 * The same run again: only what failed runs, with a fresh retry budget.
 * `version` is the one the caller saw, so a stale request is refused.
 */
const reopen = (runId: string, version: number) =>
  Client.retry(runId, { expectedVersion: version })

/**
 * A new run from the stored input. The declaration's idempotency builder
 * would name the first run again, so the key is replaced.
 */
const chargeAgain = (runId: string) =>
  Client.restart(runId, {
    definitions: [Charge],
    idempotencyKey: ['charge', runId, 'again'],
  })
// #endregion

// #region inspector
// Server: the graph deployed now, and everything the workers serve.
const graph = serializeWorkflowGraph(Billing)
const catalog = serializeWorkflowCatalog({
  workflows: Billing.workflows,
  tasks: Billing.tasks,
})

// Server: one run with the graph it was created with, from the store alone.
const inspectRun = (runId: string) => Client.inspect(runId)

// Browser: an inspection arrives as JSON; the helpers need nothing else.
const draw = ({ detail, definition }: RunInspection) => ({
  graph:
    definition.source === 'saved' && definition.structure.kind === 'workflow'
      ? renderWorkflowGraph(definition.structure, definition.presentation)
      : undefined,
  // The children of one step, each with its attempts and its child run.
  payment: nodeUnits(detail, 'payment'),
})
// #endregion

// #region workers
const served = {
  workflows: [Billing, ManualBilling],
  tasks: [CreateInvoice, ChargeCard, RequestApproval, RecordPayment],
}

const NightlyBilling = schedule({
  name: 'billing.nightly',
  runnable: Billing,
  input: { id: 'nightly', mode: 'automatic', cents: 0 },
  cron: '0 2 * * *',
  timeZone: 'Europe/Berlin',
})

// Throws unless everything a served workflow can start is served too, once,
// and every pool a declaration names is one of these.
Worker.verify({ ...served, pools: ['billing', 'payments'] })

const workers = Effect.all(
  [
    Worker.coordinator({
      workflows: served.workflows,
      concurrency: 4,
      schedules: [NightlyBilling],
      retention: { olderThan: '30d', statuses: ['completed'] },
    }),
    Worker.execution({ ...served, pool: 'billing', concurrency: 8 }),
    // ChargeCard runs here, so this worker requires Payments.
    Worker.execution({
      ...served,
      pool: 'payments',
      concurrency: 2,
      cleanupTimeoutMs: 1_000,
    }),
  ],
  { concurrency: 'unbounded', discard: true },
).pipe(
  Effect.provideService(Payments, {
    charge: (invoice, cents) => Effect.succeed(`card:${invoice}:${cents}`),
  }),
)
// #endregion

// #region postgres
/** An insert of the application's and a run, committed or rolled back as one. */
const placeOrder = (order: typeof Order.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO orders (id) VALUES (${order.id})`
        return yield* Client.start(Charge, order)
      }),
    )
  })
// #endregion

/** Waits for a run to end, and answers with it. */
const ended = (runId: string) =>
  Effect.gen(function* () {
    yield* Stream.runDrain(Client.watch(runId, { pollIntervalMs: 50 }))
    return (yield* Client.get(runId))!.run
  })

// #region durable
const Section = Schema.Struct({ id: Schema.String, hard: Schema.Boolean })

const DraftSection = task({
  name: 'docs.draft',
  revision: 'v1',
  pool: 'docs',
  input: Section,
  output: Schema.Struct({ text: Schema.String, ok: Schema.Boolean }),
  handler: ({ id, hard }) => Effect.succeed({ text: `draft ${id}`, ok: !hard }),
})

const Document = durable(
  {
    name: 'docs.document',
    revision: 'v1',
    pool: 'docs',
    input: Schema.Struct({ sections: Schema.Array(Section) }),
    output: Schema.Array(Schema.String),
    // Everything the body may start, each with a revision of its own.
    tasks: [DraftSection],
  },
  ({ sections }, d) =>
    Effect.gen(function* () {
      const drafts: string[] = []
      // Steps from the run's input, one operation name per occurrence.
      for (const section of sections) {
        const draft = yield* d.task(
          `draft:${section.id}`,
          DraftSection,
          section,
        )
        drafts.push(draft.text)
        // A decision on a real value: nothing like it is declared beforehand.
        if (!draft.ok) yield* d.sleep(`cool-off:${section.id}`, '1h')
      }
      return drafts
    }),
)
// #endregion

// #region inputs
const Publish = task({
  name: 'docs.publish',
  revision: 'v1',
  pool: 'docs',
  input: Schema.String,
  output: Schema.Void,
  handler: () => Effect.void,
})

const Review = durable(
  {
    name: 'docs.review',
    revision: 'v1',
    pool: 'docs',
    input: Schema.Struct({
      id: Schema.String,
      sections: Schema.Array(Schema.String),
    }),
    output: Schema.Array(Schema.String),
    tasks: [Publish],
    inputs: { verdict: Schema.Struct({ approved: Schema.Boolean }) },
    unique: { key: ({ id }) => ['review', id], behavior: 'join' },
  },
  ({ sections }, d) =>
    Effect.forEach(sections, (section) =>
      Effect.gen(function* () {
        // Opened together: a verdict sent as soon as the section is out
        // finds the wait there, and one sent earlier is kept for it.
        const [, verdict] = yield* Effect.all(
          [
            d.task(`publish:${section}`, Publish, section),
            d.input('verdict', section, { timeout: '7d' }),
          ],
          { concurrency: 'unbounded' },
        )
        if (verdict._tag === 'TimedOut') return `${section}: expired`
        return `${section}: ${verdict.value.approved ? 'approved' : 'rejected'}`
      }),
    ),
)

/** Sent with the reviewer's own writes, or not at all. */
const decide = (id: string, section: string, approved: boolean) =>
  Client.send(Review, { unique: ['review', id] }, 'verdict', section, {
    approved,
  })
// #endregion

// #region resume
// The run as the operator saw it: a resume decided on an older view is refused.
const unblock = (runId: string, version: number) =>
  Client.resume(runId, { expectedVersion: version })
// #endregion

// #region durable-view
// Server: the run, and the runs its operations started, in one read.
const durableDetail = (runId: string) =>
  Client.getDetail(runId, { children: true })

// Browser: what the run did, waits for, and is blocked by.
const show = (detail: RunDetail) => {
  const view = durableView(detail)
  if (!view) return undefined
  return {
    waitingFor: view.operations.flatMap((operation) =>
      operation.kind === 'input' && operation.state === 'waiting'
        ? [`${operation.family} ${operation.key}`]
        : [],
    ),
    canResume: view.blockers.some(({ actions }) =>
      actions.some((action) => action === 'resume'),
    ),
  }
}
// #endregion

describe('the quick start', () => {
  it.live('runs a workflow to its output on the in-memory store', () =>
    Effect.gen(function* () {
      expect(yield* quickstart).toStrictEqual({
        greeting: 'Hello, Ada',
        length: 10,
      })
    }),
  )
})

describe('the durable workflow example', () => {
  it.effect('decides its steps from the run and sleeps durably', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Document, {
          sections: [
            { id: 'intro', hard: true },
            { id: 'body', hard: false },
          ],
        })
        // The hard section sleeps an hour before the next is drafted.
        yield* serve(Document, 30 * 60_000)
        expect((yield* Client.get(run.id))!.run.status).toBe('waiting')
        yield* serve(Document, 40 * 60_000)
        const done = (yield* Client.get(run.id))!.run
        expect(decodeRun(Document, done).output).toEqual([
          'draft intro',
          'draft body',
        ])
      }),
    )
  })
})

describe('the durable inputs example', () => {
  it.effect('waits for verdicts sent by key, and for their deadline', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Review, {
          id: 'r-1',
          sections: ['intro', 'body'],
        })
        // Sent before the run has published anything: kept for it.
        yield* decide('r-1', 'intro', true)
        yield* serve(Review)
        // Nobody decides on the body: its week passes at once.
        yield* TestClock.adjust('8 days')
        yield* serve(Review)
        const done = (yield* Client.get(run.id))!.run
        expect(decodeRun(Review, done).output).toEqual([
          'intro: approved',
          'body: expired',
        ])
      }),
    )
  })
})

describe('the resume example', () => {
  it.effect('refuses a resume of a run that is not blocked', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Review, { id: 'r-2', sections: [] })
        const refused = yield* Effect.flip(unblock(run.id, run.version))
        expect(refused._tag).toBe('RunNotBlocked')
      }),
    )
  })
})

describe('the durable view example', () => {
  it.effect('shows what a durable run waits for', () => {
    const { provide } = deployment()
    return provide(
      Effect.gen(function* () {
        const run = yield* Client.start(Review, {
          id: 'r-3',
          sections: ['intro'],
        })
        yield* serve(Review)
        const detail = yield* durableDetail(run.id)
        expect(show(detail!)).toEqual({
          waitingFor: ['verdict intro'],
          canResume: false,
        })
      }),
    )
  })
})

describe('the stop reason example', () => {
  it.effect(
    'ends a reply for readers only when no delivery takes it over',
    () => {
      const { provide } = deployment()
      const ended: string[] = []
      const replies = Replies.of({
        write: () => Effect.never,
        end: (_key, reason) => Effect.sync(() => void ended.push(reason)),
      })

      return provide(
        Effect.gen(function* () {
          const run = yield* Client.start(Reply, 'hello')
          // The workers stop under it: the reply is another delivery's.
          yield* serve({ tasks: [Reply] }, 10_000)
          expect(ended).toStrictEqual([])

          yield* serve({ tasks: [Reply] }, 150_000)
          expect(ended).toStrictEqual(['timedOut'])
          expect((yield* Client.get(run.id))!.attempts).toMatchObject([
            { status: 'timedOut' },
          ])
        }).pipe(Effect.provideService(Replies, replies)),
      )
    },
  )
})

describe('the client examples', () => {
  const order = (id: string) => ({ id, tenant: 'acme', cents: 1200 })

  it.effect('start by keys: a replay, a conflict, a cancellation', () => {
    const { provide } = deployment()

    return provide(
      Effect.gen(function* () {
        const first = yield* Client.start(Charge, order('o-1'))
        expectTypeOf(first.input.cents).toEqualTypeOf<number>()
        expect(first).toMatchObject({
          kind: 'task',
          status: 'queued',
          tags: { tenant: 'acme' },
          idempotencyKey: ['charge', 'o-1'],
          unique: { key: ['tenant', 'acme'], scope: 'active' },
        })
        expect((yield* Client.get(first.id))!.run.input).toStrictEqual({
          id: 'o-1',
          tenant: 'acme',
          cents: '1200',
        })

        // The same request again is answered with its run.
        expect((yield* Client.start(Charge, order('o-1'))).id).toBe(first.id)
        expect(yield* admit(order('o-1'))).toStrictEqual({ started: first.id })
        // Another order of the tenant is refused while that run is active.
        expect(yield* admit(order('o-2'))).toStrictEqual({
          busyWith: first.id,
        })
        // The key under another input is a caller's mistake.
        const mistaken = yield* Effect.flip(
          Client.start(Charge, { ...order('o-1'), cents: 1 }),
        )
        expect(mistaken).toMatchObject({
          _tag: 'IdempotencyConflict',
          runId: first.id,
        })

        // A task run is cancelled by the request itself.
        expect(yield* Client.cancel(first.id)).toMatchObject({
          status: 'cancelled',
        })
        expect(yield* Client.cancel('no-such-run')).toBeUndefined()
        const second = yield* admit(order('o-2'))
        expect(second).toHaveProperty('started')

        const { runs } = yield* Client.list({
          tags: { tenant: 'acme' },
          status: ['queued', 'running'],
        })
        expect(runs.map(({ id }) => id)).toStrictEqual(Object.values(second))
      }),
    )
  })

  it.effect('retry reopens the failed run, restart starts another', () => {
    const { provide } = deployment()
    const keys: string[] = []
    let down = true
    const gateway = Effect.provideService(Gateway, {
      charge: (key, cents) => {
        keys.push(key)
        return down
          ? Effect.fail(new Error('gateway down'))
          : Effect.succeed(`ch-${cents}`)
      },
    })

    return provide(
      gateway(
        Effect.gen(function* () {
          const run = yield* Client.start(Charge, order('o-1'))
          yield* serve({ tasks: [Charge] })
          const failed = (yield* Client.get(run.id))!
          expect(failed.run).toMatchObject({
            status: 'failed',
            error: { message: 'gateway down' },
          })
          // The policy's three attempts, and no more.
          expect(failed.attempts.map(({ status }) => status)).toStrictEqual([
            'failed',
            'failed',
            'failed',
          ])

          down = false
          const reopened = yield* reopen(run.id, failed.run.version)
          expect(reopened).toMatchObject({ id: run.id, status: 'queued' })
          yield* serve({ tasks: [Charge] })
          const recovered = (yield* Client.get(run.id))!
          expect(recovered.run).toMatchObject({
            status: 'completed',
            output: { id: 'o-1', reference: 'ch-1200' },
          })
          expect(recovered.attempts.map((a) => a.attemptNumber)).toStrictEqual([
            1, 2, 3, 4,
          ])
          // One key for the work, a manual retry's attempt included.
          expect(new Set(keys).size).toBe(1)
          expect(yield* Effect.flip(Client.retry(run.id))).toMatchObject({
            _tag: 'RunNotFailed',
            status: 'completed',
          })

          const again = yield* chargeAgain(run.id)
          expect(again.id).not.toBe(run.id)
          expect(again).toMatchObject({
            status: 'queued',
            input: order('o-1'),
            tags: { tenant: 'acme' },
          })
          // Without a key of its own, the builder's key answers with the run
          // that holds it.
          const replayed = yield* Client.restart(run.id, {
            definitions: [Charge],
          })
          expect(replayed.id).toBe(run.id)
        }),
      ),
    )
  })
})

describe('the worker example', () => {
  it('requires the store alone once its services are provided', () => {
    expectTypeOf(workers).toEqualTypeOf<
      Effect.Effect<
        void,
        CleanupTimeout | DefinitionConflict | StorageError,
        Store
      >
    >()
  })

  it.live('serves both pools, the schedules and the graph of a run', () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(workers)

      const manual = yield* Client.start(Billing, {
        id: 'o-1',
        mode: 'manual',
        cents: 1250,
      })
      const automatic = yield* Client.start(Billing, {
        id: 'o-2',
        mode: 'automatic',
        cents: 1250,
      })
      expect(yield* ended(manual.id)).toMatchObject({
        status: 'completed',
        output: { order: 'o-1', invoice: 'inv-o-1', paidBy: 'finance' },
      })
      expect(yield* ended(automatic.id)).toMatchObject({
        status: 'completed',
        output: {
          order: 'o-2',
          invoice: 'inv-o-2',
          paidBy: 'card:inv-o-2:1250',
        },
      })

      // The coordinator made the stored schedules those it was given.
      expect(yield* Client.schedules.list()).toMatchObject([
        {
          name: 'billing.nightly',
          runnable: { kind: 'workflow', name: 'billing' },
          cron: '0 2 * * *',
          timeZone: 'Europe/Berlin',
          enabled: true,
        },
      ])
      const triggered = yield* Client.schedules.trigger('billing.nightly')
      expect(triggered.tags).toStrictEqual({ schedule: 'billing.nightly' })

      const drawn = draw((yield* inspectRun(manual.id))!)
      const [payment] = drawn.payment
      const { detail } = (yield* inspectRun(manual.id))!

      expect(graph).toStrictEqual({
        name: 'billing',
        nodes: [
          {
            name: 'invoice',
            kind: 'task',
            target: { kind: 'task', name: 'billing.invoice' },
          },
          {
            name: 'payment',
            kind: 'branch',
            cases: [
              {
                key: 'manual',
                kind: 'workflow',
                target: { kind: 'workflow', name: 'billing.manual' },
              },
              {
                key: 'automatic',
                kind: 'task',
                target: { kind: 'task', name: 'billing.charge' },
              },
            ],
          },
        ],
      })
      expect(catalog.workflows.map(({ name }) => name)).toStrictEqual([
        'billing',
        'billing.manual',
      ])
      expect(catalog.tasks.map(({ name }) => name).toSorted()).toStrictEqual([
        'billing.approval',
        'billing.charge',
        'billing.invoice',
        'billing.record',
      ])
      // Billing declares no labels, so the saved graph draws as the deployed.
      expect(drawn.graph).toStrictEqual(graph)
      expect(payment).toMatchObject({
        key: 'case:manual',
        parsed: { kind: 'case', caseKey: 'manual' },
        child: { kind: 'workflow', status: 'completed' },
        childRun: { name: 'billing.manual', status: 'completed' },
      })
      expect(
        detail.nodes.find(({ name }) => name === 'payment')?.selectedCase,
      ).toBe('manual')
    }).pipe(Effect.scoped, Effect.provide(InMemory.layer())),
  )
})

// Each test starts a database of its own and installs the schema in it:
// seconds on a slow runner, past the default timeout.
describe('the PostgreSQL example', { timeout: 30_000 }, () => {
  // #region postgres-layer
  // PGlite: PostgreSQL in the process, for tests and local development.
  const database = Layer.orDie(PgliteClient.layer())
  const store = Postgres.layer().pipe(
    // Optional: without it workers find their work by polling alone.
    Layer.provide(PostgresPglite.notifications),
    // `install` is for tests; production migrations are the application's.
    Layer.provide(Layer.effectDiscard(Effect.orDie(Postgres.install))),
    Layer.provideMerge(database),
  )
  // #endregion

  it.live('a start commits and rolls back with its caller', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`CREATE TABLE orders (id text PRIMARY KEY)`
      const count = Effect.map(
        sql<{ count: number }>`SELECT count(*)::int AS count FROM orders`,
        ([row]) => row!.count,
      )
      const order = { id: 'o-1', tenant: 'acme', cents: 1200 }

      const run = yield* placeOrder(order)
      expect((yield* Client.get(run.id))?.run.status).toBe('queued')
      expect(yield* count).toBe(1)

      // The tenant is busy, so the start fails and the insert goes with it.
      const refused = yield* Effect.flip(placeOrder({ ...order, id: 'o-2' }))
      expect(refused).toMatchObject({ _tag: 'RunConflict', runId: run.id })
      expect(yield* count).toBe(1)
    }).pipe(Effect.provide(store)),
  )
})
