import { Client, Worker } from '@nmtjs/workflows'
import * as Effect from 'effect/Effect'
import { describe, expect } from 'vitest'

import type { StoreSpec } from './fixtures/store.ts'
import type { WorkerConfig } from './fixtures/worker.ts'
import { EverySecond, Tick } from './fixtures/app.ts'
import {
  ended,
  requireServices,
  scenario,
  serve,
  spawnWorker,
  targets,
  until,
  workspace,
} from './support.ts'

/**
 * Schedules fired by several coordinators at once, in this process and in
 * others, on the real clock: every slot once, and none while turned off.
 */

requireServices()

const scheduler = (spec: StoreSpec): WorkerConfig => ({
  store: spec,
  served: ['tick'],
  coordinator: { pollMs: 25, schedules: true, scheduling: { everyMs: 100 } },
  execution: [{ pollMs: 25, concurrency: 4 }],
})

/** The runs the schedule started, by the slot each was started for. */
const fired = Effect.map(
  Client.list({ tags: { schedule: EverySecond.name }, limit: 1_000 }),
  ({ runs }) =>
    runs
      .map((run) => ({
        run,
        slot: (run.idempotencyKey as [string, string, number])[2],
      }))
      .toSorted((a, b) => a.slot - b.slot),
)

for (const target of targets) {
  describe.skipIf(!target.url)(`schedules on ${target.name}`, () => {
    scenario(
      target,
      'fires every slot once, however many coordinators in however many processes find it due',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const processes = yield* Effect.all(
            [
              spawnWorker(scheduler(spec), ws),
              spawnWorker(scheduler(spec), ws),
            ],
            { concurrency: 'unbounded' },
          )
          const coordinator = Worker.coordinator({
            workflows: [Tick],
            pollMs: 25,
            schedules: [EverySecond],
            scheduling: { everyMs: 100 },
          })
          yield* serve(coordinator, coordinator)

          const slots = yield* until(
            'four slots to be fired',
            Effect.map(fired, (runs) => runs.length >= 4 && runs),
            {
              details: () => processes.map(({ output }) => output()).join('\n'),
            },
          )
          // One run for each slot, a whole period apart: a slot is skipped
          // only when nobody fired it in time, never fired twice.
          const times = slots.map(({ slot }) => slot)
          expect(new Set(times).size).toBe(times.length)
          for (const [index, slot] of times.slice(1).entries()) {
            const gap = slot - times[index]!
            expect(gap % 1_000).toBe(0)
            expect(gap).toBeGreaterThan(0)
          }
          for (const { run } of slots) {
            expect(run.idempotencyKey).toEqual([
              '$schedule',
              EverySecond.name,
              expect.any(Number),
            ])
            expect((yield* ended(run.id)).run.status).toBe('completed')
          }
          // Each run's handler ran once.
          const ticked = (yield* ws.events)
            .filter(({ event }) => event === 'ticked')
            .map(({ runId }) => runId)
          for (const { run } of slots) {
            expect(ticked.filter((runId) => runId === run.id)).toHaveLength(1)
          }
          const [stored] = yield* Client.schedules.list()
          expect(stored!.lastSlotAt).toBeGreaterThanOrEqual(times.at(-1)!)
        }),
    )

    scenario(
      target,
      'fires nothing while a schedule is turned off, and goes on from its next slot when turned on',
      (spec) =>
        Effect.gen(function* () {
          const ws = yield* workspace
          const process = yield* spawnWorker(scheduler(spec), ws)
          yield* until(
            'a slot to be fired',
            Effect.map(fired, (runs) => runs.length > 0),
            { details: process.output },
          )

          yield* Client.schedules.setEnabled(EverySecond.name, false)
          const offAt = Date.now()
          const before = (yield* fired).length
          // Slots of the next seconds come and go.
          yield* Effect.sleep('2500 millis')
          const during = yield* fired
          // A fire under way as it was turned off may still land, before.
          expect(during.length - before).toBeLessThanOrEqual(1)
          for (const { slot } of during) expect(slot).toBeLessThan(offAt)

          yield* Client.schedules.setEnabled(EverySecond.name, true)
          const onAt = Date.now()
          const resumed = yield* until(
            'a slot to be fired again',
            Effect.map(fired, (runs) => {
              const later = runs.filter(({ slot }) => slot >= offAt)
              return later.length > 0 && later
            }),
            { details: process.output },
          )
          // The slots missed while it was off are not made up for.
          for (const { slot } of resumed) {
            expect(slot).toBeGreaterThanOrEqual(onAt - 25)
          }
        }),
    )
  })
}
