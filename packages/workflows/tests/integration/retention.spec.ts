import * as NodeRedis from '@effect/platform-node/NodeRedis'
import { Client, task, Worker, workflow } from '@nmtjs/workflows'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect } from 'vitest'

import type { StoreSpec } from './fixtures/store.ts'
import { postgresClient } from './fixtures/store.ts'
import {
  reached,
  redisKeys,
  requireServices,
  scenario,
  serve,
  settled,
  targets,
  until,
} from './support.ts'

/**
 * A coordinator pruning what ended while runs keep starting, ending and
 * running: everything of an ended family goes, all at once, and nothing of
 * a family with anything in flight.
 */

requireServices()

const text = { input: Schema.String, output: Schema.String }
const versioned = { revision: 'v1', pool: 'p' } as const

/**
 * Whatever the store still keeps of these runs, read past the engine: rows
 * that name them on PostgreSQL, keys that name them on Redis.
 */
const leftovers = (spec: StoreSpec, runIds: readonly string[]) =>
  spec.kind === 'postgres'
    ? Effect.gen(function* () {
        const sql = Context.get(
          yield* Layer.build(postgresClient(spec, 1)),
          SqlClient.SqlClient,
        )
        const [row] = yield* sql.unsafe<{ count: number }>(
          `SELECT
             (SELECT count(*) FROM workflow_runs WHERE id = ANY($1::uuid[]))
           + (SELECT count(*) FROM workflow_nodes WHERE run_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM workflow_node_children WHERE run_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM workflow_attempts WHERE run_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM workflow_keys WHERE run_id = ANY($1::uuid[]))
           + (SELECT count(*) FROM workflow_commands WHERE run_id = ANY($1::uuid[]))
             AS count`,
          [runIds],
        )
        return Number(row!.count)
      }).pipe(Effect.scoped, Effect.orDie)
    : Effect.map(
        redisKeys(spec.prefix),
        (keys) =>
          keys.filter((key) => runIds.some((id) => key.includes(id))).length,
      ).pipe(Effect.provide(NodeRedis.layer({ url: spec.url })), Effect.orDie)

for (const target of targets) {
  describe.skipIf(!target.url)(`retention on ${target.name}`, () => {
    scenario(
      target,
      'prunes whole families once they ended, while others start, end and run beside them',
      (spec) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>()
          const Stamp = task({
            ...text,
            ...versioned,
            name: 'keep.stamp',
            handler: (input) => Effect.succeed(`${input}!`),
          })
          const Broken = task({
            ...text,
            ...versioned,
            name: 'keep.broken',
            handler: (input) => Effect.fail(new Error(`no ${input}`)),
          })
          const Child = workflow(
            { ...text, ...versioned, name: 'keep.child' },
            function* (w) {
              return yield* w.task('stamp', Stamp, { input: w.input })
            },
          )
          const Quick = workflow(
            { ...text, ...versioned, name: 'keep.quick' },
            function* (w) {
              const first = yield* w.activity('first', {
                ...text,
                from: w.input,
                handler: (input) => Effect.succeed(input),
              })
              return yield* w.workflow('child', Child, { input: first })
            },
          )
          const Lingering = workflow(
            { ...text, ...versioned, name: 'keep.lingering' },
            function* (w) {
              return yield* w.activity('wait', {
                ...text,
                from: w.input,
                handler: (input) => Effect.as(Deferred.await(release), input),
              })
            },
          )
          const Detaching = workflow(
            { ...text, ...versioned, name: 'keep.detaching' },
            function* (w) {
              return yield* w.workflow('free', Lingering, {
                input: w.input,
                cancellation: 'detach',
              })
            },
          )
          const served = {
            workflows: [Quick, Child, Lingering, Detaching],
            tasks: [Stamp, Broken],
          }
          yield* serve(
            Worker.coordinator({
              workflows: served.workflows,
              pollMs: 25,
              concurrency: 4,
              retention: { olderThan: '1s', everyMs: 200, batchSize: 2 },
            }),
            Worker.execution({ ...served, pollMs: 25, concurrency: 8 }),
          )

          // In flight for as long as the test lets them be: a run of its
          // own, and the child of a parent that ended without it.
          const held = yield* Client.start(Lingering, 'held')
          const parent = yield* Client.start(Detaching, 'parent')
          const [free] = (yield* reached(parent.id, 'waiting')).children
          yield* Client.cancel(parent.id)
          yield* reached(parent.id, 'cancelled')
          yield* reached(free!.childRunId!, 'running')

          // Load: runs that complete and runs that fail, started all along
          // while the sweeps go on. The first holds keys that outlive it.
          const keyed = {
            idempotencyKey: ['keyed'],
            unique: { key: ['tenant', 'acme'], scope: 'all' as const },
          }
          const started: string[] = []
          const load = yield* Effect.forkScoped(
            Effect.gen(function* () {
              started.push((yield* Client.start(Quick, 'keyed', keyed)).id)
              for (let index = 0; index < 60; index++) {
                const run =
                  index % 4 === 3
                    ? yield* Client.start(Broken, `b${index}`)
                    : yield* Client.start(Quick, `q${index}`)
                started.push(run.id)
                yield* Effect.sleep('50 millis')
              }
            }),
          )
          yield* Fiber.join(load)

          // Every family that ended goes, the runs under it with it.
          const kept = new Set([held.id, parent.id, free!.childRunId!])
          const runs = yield* until(
            'only the families in flight to be left',
            Effect.map(
              Client.list({ limit: 1_000 }),
              ({ runs }) => runs.every(({ id }) => kept.has(id)) && runs,
            ),
            { timeoutMs: 45_000 },
          )
          expect(runs.map(({ id }) => id).toSorted()).toEqual(
            Array.from(kept).toSorted(),
          )
          for (const runId of started) {
            expect(yield* Client.getFamily(runId)).toEqual([])
          }
          expect(yield* leftovers(spec, started)).toBe(0)
          expect(yield* settled(Array.from(kept))).toMatchObject({ dead: [] })
          // Saved definitions are shared, and stay.
          expect(
            yield* Client.getDefinition({
              kind: 'workflow',
              name: Quick.name,
              revision: 'v1',
            }),
          ).toBeDefined()
          // The keys went with their run.
          const again = yield* Client.start(Quick, 'keyed', keyed)
          expect(started).not.toContain(again.id)

          // Let go, the rest ends, and goes in its turn.
          yield* Deferred.succeed(release, undefined)
          yield* reached(held.id, 'completed')
          yield* reached(free!.childRunId!, 'completed')
          yield* reached(again.id, 'completed')
          yield* until(
            'everything to be pruned',
            Effect.map(Client.list(), ({ runs }) => runs.length === 0),
            { timeoutMs: 30_000 },
          )
        }),
      { timeout: 120_000 },
    )
  })
}
