import { Client } from '@nmtjs/workflows'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'
import * as Stream from 'effect/Stream'
import { describe, expect } from 'vitest'

import type { OrderInput } from './fixtures/app.ts'
import type { StoreSpec } from './fixtures/store.ts'
import type { WorkerConfig } from './fixtures/worker.ts'
import { Order, orderOutput } from './fixtures/app.ts'
import { channel, postgresClient } from './fixtures/store.ts'
import {
  postgres,
  reached,
  requireServices,
  scenario,
  spawnWorker,
  targets,
  until,
  workspace,
} from './support.ts'

/**
 * Hints from one process waking workers and watchers in another, and work
 * that is found all the same when no hint is heard.
 */

requireServices()

const order = (id: string, hold: OrderInput['hold'] = 'none'): OrderInput => ({
  id,
  items: ['a', 'b'],
  express: false,
  hold,
})

/** Longer than any test waits: a worker that moves was woken by a hint. */
const IDLE = 120_000

const worker = (
  spec: StoreSpec,
  { pollMs = IDLE, leaseMs }: { pollMs?: number; leaseMs?: number } = {},
): WorkerConfig => ({
  store: spec,
  served: ['order'],
  coordinator: { pollMs, concurrency: 4, ...(leaseMs ? { leaseMs } : {}) },
  execution: [{ pollMs, concurrency: 4, ...(leaseMs ? { leaseMs } : {}) }],
})

for (const target of targets) {
  describe.skipIf(!target.url)(`wake events on ${target.name}`, () => {
    scenario(
      target,
      'wakes an idle worker in another process on the hint of a start',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const idle = yield* spawnWorker(worker(spec), ws)
          // It has looked once, found nothing, and waits.
          yield* Effect.sleep('500 millis')
          const startedAt = Date.now()
          const run = yield* Client.start(Order, order('w1'))

          const { run: done } = yield* reached(run.id, 'completed', {
            details: idle.output,
          })
          expect(done.output).toEqual(orderOutput(order('w1')))
          expect(Date.now() - startedAt).toBeLessThan(IDLE / 2)
        }),
    )

    scenario(
      target,
      'tells a watcher in one process of every status a run takes in another, without polling',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const run = yield* Client.start(Order, order('w2'))
          const watching = yield* Effect.forkScoped(
            Stream.runCollect(
              Client.watch(run.id, { wake: true, pollIntervalMs: IDLE }),
            ),
          )
          // The watcher has read the run before the worker exists.
          yield* Effect.sleep('300 millis')
          const busy = yield* spawnWorker(worker(spec), ws)

          const events: readonly Client.WatchEvent[] = yield* Fiber.join(
            watching,
          ).pipe(
            Effect.timeout('30 seconds'),
            Effect.tapError(() =>
              Effect.sync(() => console.error(busy.output())),
            ),
          )
          const statuses = events.flatMap((event) =>
            event.kind === 'run' ? [event.status] : [],
          )
          expect(statuses[0]).toBe('queued')
          expect(statuses.at(-1)).toBe('completed')
          expect(statuses).toContain('waiting')
          // Steps of the family changed in between, and were told of too.
          expect(events.some(({ kind }) => kind === 'change')).toBe(true)
        }),
    )

    scenario(
      target,
      'stops a handler in another process at once when its run is cancelled',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          // Renewed every 100 seconds: only a hint explains a prompt stop.
          const holding = yield* spawnWorker(
            worker(spec, { pollMs: 25, leaseMs: 300_000 }),
            ws,
          )
          const run = yield* Client.start(Order, order('w3', 'activity'))
          yield* until('the activity to be held', ws.held('w3.activity'), {
            details: holding.output,
          })

          yield* Client.cancel(run.id)
          yield* until(
            'the handler to be interrupted',
            Effect.map(ws.events, (events) =>
              events.some(({ event }) => event === 'interrupted'),
            ),
            { timeoutMs: 20_000, details: holding.output },
          )
          const { attempts } = yield* reached(run.id, 'cancelled', {
            details: holding.output,
          })
          expect(attempts).toMatchObject([
            { nodeName: 'prepare', status: 'cancelled' },
          ])
        }),
    )
  })
}

describe.skipIf(!postgres.url)(
  'wake events on PostgreSQL, without a listener',
  () => {
    /** The connection of the database that listens for the schema's hints. */
    const listeners = (sql: SqlClient.SqlClient, schema: string) =>
      sql.unsafe<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database()
         AND query ILIKE 'LISTEN%' AND query LIKE $1`,
        [`%${channel(schema)}%`],
      )

    scenario(
      postgres,
      'finds work by polling when the store listens for nothing',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const deaf = yield* spawnWorker(
            worker({ ...spec, hints: false } as StoreSpec, { pollMs: 300 }),
            ws,
          )
          const run = yield* Client.start(Order, order('d1'))
          const { run: done } = yield* reached(run.id, 'completed', {
            details: deaf.output,
          })
          expect(done.output).toEqual(orderOutput(order('d1')))
        }),
    )

    scenario(
      postgres,
      'listens again when its connection is lost, and finds what was hinted meanwhile',
      (spec) =>
        Effect.gen(function* () {
          if (spec.kind !== 'postgres') return
          const ws = yield* workspace
          const sql = Context.get(
            yield* Layer.build(postgresClient(spec, 1)),
            SqlClient.SqlClient,
          )
          // This process's store listens on the channel too.
          const ours = new Set(
            (yield* listeners(sql, spec.schema)).map(({ pid }) => pid),
          )
          const idle = yield* spawnWorker(worker(spec), ws)
          const [listener] = yield* until(
            'the worker to listen',
            Effect.map(listeners(sql, spec.schema), (rows) => {
              const theirs = rows.filter(({ pid }) => !ours.has(pid))
              return theirs.length > 0 ? theirs : undefined
            }),
          )

          // The worker loses the connection it hears hints on, and nothing
          // else; a start is hinted while nobody listens.
          yield* sql.unsafe('SELECT pg_terminate_backend($1)', [listener!.pid])
          const run = yield* Client.start(Order, order('d2'))

          // Back, it does not know what it missed, so it looks: the run is
          // found long before the worker would poll for it.
          yield* until(
            'the worker to listen again',
            Effect.map(listeners(sql, spec.schema), (rows) =>
              rows.some(({ pid }) => pid !== listener!.pid && !ours.has(pid)),
            ),
            { details: idle.output },
          )
          yield* reached(run.id, 'completed', { details: idle.output })

          // And it is woken by hints again.
          const next = yield* Client.start(Order, order('d3'))
          yield* reached(next.id, 'completed', { details: idle.output })
          expect(idle.output()).toContain('Workflow hints are not listened for')
        }),
    )
  },
)
