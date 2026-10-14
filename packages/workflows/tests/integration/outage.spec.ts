import { Client, Worker, workflow } from '@nmtjs/workflows'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import { describe, expect } from 'vitest'

import { storeLayer } from './fixtures/store.ts'
import {
  reached,
  requireServices,
  scenario,
  serve,
  settled,
  targets,
  tcpProxy,
} from './support.ts'

/**
 * The store out of reach for a while under running work: workers fail with
 * what the store failed them with, whoever supervises them starts them
 * again, and the run goes on from what was committed, losing and repeating
 * nothing.
 */

requireServices()

const text = { input: Schema.String, output: Schema.String }

for (const target of targets) {
  describe.skipIf(!target.url)(`a storage outage on ${target.name}`, () => {
    scenario(
      target,
      'goes on once the store is back, with every step done once',
      (spec) =>
        Effect.gen(function* () {
          const proxy = yield* tcpProxy(spec.url)
          // The workers reach the store through the proxy; the test does not.
          const remote = yield* Layer.build(
            storeLayer({ ...spec, url: proxy.url }),
          )
          const calls = { hold: 0, after: 0 }
          const holding = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const Flow = workflow(
            { ...text, name: 'outage.flow', pool: 'p' },
            function* (w) {
              const held = yield* w.activity('hold', {
                ...text,
                from: w.input,
                handler: (input) =>
                  Effect.gen(function* () {
                    calls.hold += 1
                    yield* Deferred.succeed(holding, undefined)
                    yield* Deferred.await(release)
                    return `${input} held`
                  }),
              })
              return yield* w.activity('after', {
                ...text,
                from: held,
                handler: (input) =>
                  Effect.sync(() => {
                    calls.after += 1
                    return `${input}, then after`
                  }),
              })
            },
          )
          const failures: string[] = []
          // A supervisor as a host has one: a worker that fails is started
          // again after a pause.
          const supervised = <E, R>(worker: Effect.Effect<never, E, R>) =>
            worker.pipe(
              Effect.tapError((error) =>
                Effect.sync(() =>
                  failures.push(
                    (error as { _tag?: string })._tag ?? String(error),
                  ),
                ),
              ),
              Effect.retry(Schedule.spaced('200 millis')),
              Effect.provide(remote),
            )
          yield* serve(
            supervised(Worker.coordinator({ workflows: [Flow], pollMs: 50 })),
            supervised(Worker.execution({ workflows: [Flow], pollMs: 50 })),
          )
          const run = yield* Client.start(Flow, 'x')
          yield* Deferred.await(holding)

          // Out of reach for longer than the workers wait between looks.
          yield* proxy.cut
          yield* Effect.sleep('2 seconds')
          yield* proxy.restore
          yield* Deferred.succeed(release, undefined)

          const { run: done, attempts } = yield* reached(run.id, 'completed', {
            details: () => `failures: ${failures.join(', ')}`,
          })
          expect(done.output).toBe('x held, then after')
          expect(calls).toEqual({ hold: 1, after: 1 })
          expect(
            attempts
              .map(({ nodeName, status, attemptNumber }) => ({
                nodeName,
                status,
                attemptNumber,
              }))
              .toSorted((a, b) => a.nodeName.localeCompare(b.nodeName)),
          ).toEqual([
            { nodeName: 'after', status: 'completed', attemptNumber: 1 },
            { nodeName: 'hold', status: 'completed', attemptNumber: 1 },
          ])
          // A worker the store failed says so with what it failed with. On
          // PostgreSQL a refused connection fails a claim at once; a Redis
          // client queues its commands until it reconnects, and so waits.
          for (const failure of failures) expect(failure).toBe('StorageError')
          if (spec.kind === 'postgres')
            expect(failures.length).toBeGreaterThan(0)
          expect(yield* settled([run.id])).toEqual({ dead: [], claimed: [] })
        }),
    )
  })
}
