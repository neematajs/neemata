import type * as Scope from 'effect/Scope'
import { Client, describeDefinition, Store } from '@nmtjs/workflows'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it } from 'vitest'

import type { OrderInput } from './fixtures/app.ts'
import type { StoreSpec } from './fixtures/store.ts'
import { generation, Order, orderOutput } from './fixtures/app.ts'
import { postgresStore } from './fixtures/store.ts'
import {
  live,
  postgres,
  provision,
  reached,
  requireServices,
  spawnWorker,
  workspace,
} from './support.ts'

/**
 * Engine calls inside the caller's PostgreSQL transaction: they commit and
 * roll back with it, other connections and processes see nothing before
 * then, and a call that fails there leaves the transaction usable.
 */

requireServices([postgres])

const order = (id: string): OrderInput => ({
  id,
  items: ['a'],
  express: false,
  hold: 'none',
})
const v1 = generation('v1', 'io')

type Caller = Store | SqlClient.SqlClient | Scope.Scope

/**
 * A test whose store is built on the caller's client, as an application's
 * is, and a table of the caller's own beside it.
 */
function caller(
  name: string,
  body: (
    spec: Extract<StoreSpec, { kind: 'postgres' }>,
  ) => Effect.Effect<unknown, unknown, Caller>,
  options: { readonly answerTimeoutMs?: number } = {},
) {
  it(
    name,
    () =>
      live(
        Effect.gen(function* () {
          const spec = (yield* provision(postgres)) as Extract<
            StoreSpec,
            { kind: 'postgres' }
          >
          const context = yield* Layer.build(postgresStore(spec, options))
          const sql = Context.get(context, SqlClient.SqlClient)
          yield* sql.unsafe('CREATE TABLE caller_notes (note text PRIMARY KEY)')
          yield* Effect.scoped(Effect.provide(body(spec), context))
        }),
      ),
    60_000,
  )
}

const note = (text: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql.unsafe('INSERT INTO caller_notes VALUES ($1)', [text]),
  )
const notes = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql.unsafe<{ note: string }>('SELECT note FROM caller_notes ORDER BY note'),
    (rows) => rows.map(({ note }) => note),
  ),
)

/** Another connection's view: a store and client of its own. */
const elsewhere = (spec: Extract<StoreSpec, { kind: 'postgres' }>) =>
  Effect.map(Layer.build(postgresStore(spec)), (context) => ({
    run: <A, E>(
      effect: Effect.Effect<A, E, Store | SqlClient.SqlClient>,
    ): Effect.Effect<A, E> => Effect.provide(effect, context),
  }))

/** Whatever is queued for the routes of the fixture, claimed to be shown. */
const queued = Effect.flatMap(Store, (store) =>
  store.claim({
    lanes: [
      {
        kind: 'continueRun',
        routes: [
          { name: Order.name },
          { name: v1.Parent.name, revision: 'v1' },
        ],
      },
    ],
    limit: 100,
    leaseMs: 1_000,
  }),
)

describe.skipIf(!postgres.url)('caller transactions on PostgreSQL', () => {
  caller(
    'commits a run with the caller, and other connections and processes see it only then',
    (spec) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const ws = yield* workspace
        const other = yield* elsewhere(spec)
        // Idle for longer than the test: only the commit's hint wakes it.
        const worker = yield* spawnWorker(
          {
            store: spec,
            served: ['order'],
            coordinator: { pollMs: 120_000, concurrency: 4 },
            execution: [{ pollMs: 120_000, concurrency: 4 }],
          },
          ws,
        )

        const run = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* note('placed')
            const run = yield* Client.start(Order, order('t1'))
            // The caller sees its own run; nobody else does.
            expect((yield* Client.get(run.id))?.run.status).toBe('queued')
            yield* Effect.sleep('300 millis')
            expect(yield* other.run(Client.get(run.id))).toBeUndefined()
            expect(
              yield* other.run(
                Effect.map(Client.list(), ({ runs }) => runs.length),
              ),
            ).toBe(0)
            return run
          }),
        )

        expect(yield* other.run(Client.get(run.id))).toBeDefined()
        expect(yield* notes).toEqual(['placed'])
        const { run: done } = yield* reached(run.id, 'completed', {
          details: worker.output,
        })
        expect(done.output).toEqual(orderOutput(order('t1')))
      }),
  )

  caller(
    'takes a start, its command and its definitions with it when a later statement of the caller fails',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* note('taken')
        let started: string | undefined
        const exit = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              started = (yield* Client.start(v1.Parent, 'x')).id
              yield* note('first')
              // The caller's own mistake, after the start.
              yield* note('taken')
            }),
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(started).toBeDefined()
        expect(yield* Client.get(started!)).toBeUndefined()
        expect(yield* queued).toEqual([])
        expect(
          yield* Client.getDefinition({
            kind: 'workflow',
            name: v1.Parent.name,
            revision: 'v1',
          }),
        ).toBeUndefined()
        expect(yield* notes).toEqual(['taken'])
      }),
  )

  caller(
    'keeps the runs of concurrent starts within one transaction, all or none, and those refused among them undo only themselves',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const unique = { unique: { key: ['tenant', 'acme'] } }
        const holder = yield* Client.start(Order, order('holder'), unique)
        // Fibers of one transaction, so one connection: a refusal rolls back
        // to its own savepoint while the others go on around it.
        const starts = Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            index % 2 === 0
              ? Effect.map(
                  Client.start(Order, order(`c${index}`)),
                  ({ id }) => id,
                )
              : Effect.map(
                  Effect.flip(Client.start(Order, order(`d${index}`), unique)),
                  ({ _tag }) => _tag,
                ),
          ),
          { concurrency: 'unbounded' },
        )

        const rolledBack = yield* Effect.exit(
          sql.withTransaction(
            Effect.andThen(starts, Effect.fail('changed my mind' as const)),
          ),
        )
        expect(Exit.isFailure(rolledBack)).toBe(true)
        expect((yield* Client.list()).runs.map(({ id }) => id)).toEqual([
          holder.id,
        ])

        const outcomes = yield* sql.withTransaction(starts)
        const started = outcomes.filter((_, index) => index % 2 === 0)
        expect(outcomes.filter((_, index) => index % 2 === 1)).toEqual(
          Array.from({ length: 4 }, () => 'RunConflict'),
        )
        expect(
          (yield* Client.list()).runs.map(({ id }) => id).toSorted(),
        ).toEqual([holder.id, ...started].toSorted())
        // Each with the command that starts it.
        expect(yield* queued).toHaveLength(5)
      }),
  )

  caller(
    "holds up no other start, and no run, of a workflow while a caller's transaction that started one is open",
    (spec) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const ws = yield* workspace
        const saved = yield* Client.start(Order, order('saved'))
        const worker = yield* spawnWorker(
          {
            store: spec,
            served: ['order'],
            coordinator: { pollMs: 25, concurrency: 4 },
            execution: [{ pollMs: 25, concurrency: 4 }],
          },
          ws,
        )
        const other = yield* elsewhere(spec)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* Client.start(Order, order('open'))
            // A start elsewhere, and a whole run in another process, while
            // the caller has yet to commit.
            const beside = yield* other.run(
              Effect.timeout(Client.start(Order, order('beside')), '5 seconds'),
            )
            for (const run of [saved, beside]) {
              yield* other.run(
                reached(run.id, 'completed', { details: worker.output }),
              )
            }
          }),
        )
        expect((yield* Client.list({ parentRunId: null })).runs).toHaveLength(3)
      }),
  )

  caller(
    'commits a cancellation and a restart with the caller, and undoes them with it',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const run = yield* Client.start(v1.Parent, 'x')
        const cancel = sql.withTransaction(
          Effect.gen(function* () {
            yield* note('cancelling')
            expect((yield* Client.cancel(run.id))?.status).toBe('cancelling')
            return yield* Effect.fail('not now' as const)
          }),
        )

        expect(Exit.isFailure(yield* Effect.exit(cancel))).toBe(true)
        expect((yield* Client.get(run.id))!.run).toMatchObject({
          status: 'queued',
          version: 1,
        })
        expect(yield* notes).toEqual([])

        yield* sql.withTransaction(
          Effect.andThen(note('cancelled'), Client.cancel(run.id)),
        )
        expect((yield* Client.get(run.id))!.run.status).toBe('cancelling')
        expect(yield* notes).toEqual(['cancelled'])

        // A task run is cancelled by the request itself, so it can be
        // restarted at once; the restart too is the caller's to keep.
        const task = yield* Client.start(v1.Work, 'y')
        yield* Client.cancel(task.id)
        const restart = Client.restart(task.id, { definitions: [v1.Work] })
        const undone = yield* Effect.exit(
          sql.withTransaction(
            Effect.andThen(restart, Effect.fail('not now' as const)),
          ),
        )
        expect(Exit.isFailure(undone)).toBe(true)
        expect((yield* Client.list({ name: v1.Work.name })).runs).toHaveLength(
          1,
        )
        const restarted = yield* sql.withTransaction(restart)
        expect(restarted).toMatchObject({
          name: v1.Work.name,
          revision: 'v1',
          status: 'queued',
          input: 'y',
        })
        expect((yield* Client.list({ name: v1.Work.name })).runs).toHaveLength(
          2,
        )
      }),
  )

  caller(
    'gives up a start blocked by another transaction when interrupted, and the caller goes on to commit',
    (spec) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const other = yield* elsewhere(spec)
        const unique = { unique: { key: ['tenant', 'acme'] } }
        // Saved first: a transaction that saves a definition holds up every
        // other start of it until it commits, and this one is to hold a key.
        yield* Client.start(Order, order('saved'))
        // Another transaction holds the key, and has not decided yet.
        const holding = yield* Deferred.make<void>()
        const decide = yield* Deferred.make<void>()
        const holder = yield* Effect.forkScoped(
          other.run(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  const run = yield* Client.start(Order, order('held'), unique)
                  yield* Deferred.succeed(holding, undefined)
                  yield* Deferred.await(decide)
                  return run
                }),
              ),
            ),
          ),
        )
        yield* Deferred.await(holding)

        const startedAt = Date.now()
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* note('before')
            const blocked = yield* Effect.flip(
              Effect.timeout(
                Client.start(Order, order('blocked'), unique),
                '500 millis',
              ),
            )
            expect(blocked._tag).toBe('TimeoutError')
            expect(Date.now() - startedAt).toBeLessThan(10_000)
            // The transaction is usable: it writes and starts again.
            yield* note('after')
            yield* Client.start(Order, order('other'))
          }),
        )

        yield* Deferred.succeed(decide, undefined)
        const held = yield* Fiber.join(holder)
        expect(yield* notes).toEqual(['after', 'before'])
        expect(
          (yield* Client.list()).runs
            .map(({ input }) => (input as OrderInput).id)
            .toSorted(),
        ).toEqual(['held', 'other', 'saved'])
        expect((yield* Client.get(held.id))!.run.status).toBe('queued')
      }),
  )

  caller(
    'gives up a cancellation blocked by another transaction when interrupted, and the caller goes on to commit',
    (spec) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const other = yield* elsewhere(spec)
        const run = yield* Client.start(Order, order('r1'))
        const holding = yield* Deferred.make<void>()
        const decide = yield* Deferred.make<void>()
        const holder = yield* Effect.forkScoped(
          other.run(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* Client.cancel(run.id)
                  yield* Deferred.succeed(holding, undefined)
                  yield* Deferred.await(decide)
                }),
              ),
            ),
          ),
        )
        yield* Deferred.await(holding)

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* note('before')
            const blocked = yield* Effect.flip(
              Effect.timeout(Client.cancel(run.id), '500 millis'),
            )
            expect(blocked._tag).toBe('TimeoutError')
            yield* note('after')
          }),
        )
        yield* Deferred.succeed(decide, undefined)
        yield* Fiber.join(holder)

        expect(yield* notes).toEqual(['after', 'before'])
        // The other transaction's request, and nothing of the one given up.
        expect((yield* Client.get(run.id))!.run).toMatchObject({
          status: 'cancelling',
          version: 2,
        })
      }),
  )

  caller(
    'lets a start that waits for the first saving of its revision save its own graph if that one rolls back, and refuses it if it commits',
    (spec) =>
      Effect.gen(function* () {
        const other = yield* elsewhere(spec)
        for (const outcome of ['rollback', 'commit'] as const) {
          const revision = `first-${outcome}`
          const saved = generation(revision, 'io').Parent
          const waiting = generation(revision, 'io', { reshaped: true }).Parent
          const holding = yield* Deferred.make<void>()
          const decide = yield* Deferred.make<void>()
          const holder = yield* Effect.forkScoped(
            other.run(
              Effect.flatMap(SqlClient.SqlClient, (sql) =>
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* Client.start(saved, 'first')
                    yield* Deferred.succeed(holding, undefined)
                    yield* Deferred.await(decide)
                    if (outcome === 'rollback') {
                      return yield* Effect.fail('rolled back' as const)
                    }
                  }),
                ),
              ),
            ),
          )
          yield* Deferred.await(holding)

          // Shown no revision yet, it waits for the one being saved.
          const second = yield* Effect.forkScoped(
            Effect.exit(Client.start(waiting, 'second')),
          )
          yield* Effect.sleep('500 millis')
          expect(second.pollUnsafe()).toBeUndefined()

          yield* Deferred.succeed(decide, undefined)
          yield* Effect.exit(Fiber.join(holder))
          const exit = yield* Fiber.join(second)
          const definition = yield* Client.getDefinition({
            kind: 'workflow',
            name: saved.name,
            revision,
          })
          const runs = (yield* Client.list({ revision, parentRunId: null }))
            .runs
          if (outcome === 'rollback') {
            expect(Exit.isSuccess(exit)).toBe(true)
            const { graphHash } = describeDefinition(waiting)
            expect(definition?.graph.graphHash).toBe(graphHash)
            expect(runs.map(({ input }) => input)).toEqual(['second'])
          } else {
            expect(
              Exit.isFailure(exit) && Cause.squash(exit.cause),
            ).toMatchObject({
              _tag: 'DefinitionConflict',
            })
            const { graphHash } = describeDefinition(saved)
            expect(definition?.graph.graphHash).toBe(graphHash)
            expect(runs.map(({ input }) => input)).toEqual(['first'])
          }
        }
      }),
  )

  caller(
    'fails a statement the database does not answer in time with a StorageError, and the caller goes on to commit',
    (spec) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const other = yield* elsewhere(spec)
        const unique = { unique: { key: ['tenant', 'acme'] } }
        yield* Client.start(Order, order('saved'))
        const holding = yield* Deferred.make<void>()
        const decide = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          other.run(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              sql.withTransaction(
                Effect.gen(function* () {
                  yield* Client.start(Order, order('held'), unique)
                  yield* Deferred.succeed(holding, undefined)
                  yield* Deferred.await(decide)
                }),
              ),
            ),
          ),
        )
        yield* Deferred.await(holding)

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* note('before')
            const error = yield* Effect.flip(
              Client.start(Order, order('blocked'), unique),
            )
            expect(error).toMatchObject({
              _tag: 'StorageError',
              cause: { reason: { _tag: 'StatementTimeoutError' } },
            })
            yield* note('after')
          }),
        )
        yield* Deferred.succeed(decide, undefined)
        expect(yield* notes).toEqual(['after', 'before'])
      }),
    { answerTimeoutMs: 300 },
  )
})
