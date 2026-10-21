import * as Effect from 'effect/Effect'

import type {
  AnyTask,
  CleanupTimeout,
  DefinitionConflict,
  ServedWorkflow,
  StorageError,
} from '../src/index.ts'
import { InMemory, Store, Worker } from '../src/index.ts'
import { elapse, idle } from './support.ts'

const POLL = 1_000
const LONG = 10 * 60_000

/** An in-memory store of its own, and the effect that runs against it. */
export function deployment(options?: InMemory.InMemoryOptions) {
  const memory = InMemory.makeInMemoryStore(options)
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Store, memory.store)

  return { ...memory, provide }
}

/**
 * Runs workers while the clock moves `ms`, then stops them and waits. Hours
 * of a durable sleep move a minute at a time, and the workers poll every ten
 * seconds: each adjust still wakes every poll in order, and a step or a poll
 * a second costs seconds on slow runners. The timers of these tests have a
 * minute or more of room for a later poll.
 */
const during = <R>(
  workers: (
    pollMs: number,
  ) => readonly Effect.Effect<
    never,
    CleanupTimeout | DefinitionConflict | StorageError,
    R
  >[],
  ms: number,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pollMs = ms >= LONG ? 10_000 : POLL
      for (const worker of workers(pollMs)) yield* Effect.forkScoped(worker)
      yield* idle
      yield* elapse(ms, ms >= LONG ? 60_000 : 1_000)
    }),
  )

/** A coordinator of the workflows alone: nothing runs their handlers. */
export const coordinate = (workflows: readonly ServedWorkflow[], ms = 0) =>
  during((pollMs) => [Worker.coordinator({ workflows, pollMs })], ms)

/** An execution worker alone: nothing advances the runs. */
export const execute = <W extends ServedWorkflow, T extends AnyTask>(
  served: Worker.Served<W, T>,
  ms = 0,
) =>
  during(
    (pollMs) => [Worker.execution({ ...served, pollMs, concurrency: 8 })],
    ms,
  )

/**
 * Both worker roles for what is served, long enough for any run of these
 * tests to end and for a command nobody may work to be given back often.
 */
export const serve = <W extends ServedWorkflow, T extends AnyTask>(
  served: Worker.Served<W, T>,
  ms = 20_000,
) =>
  during(
    (pollMs) => [
      Worker.coordinator({ workflows: served.workflows ?? [], pollMs }),
      Worker.execution({ ...served, pollMs, concurrency: 8 }),
    ],
    ms,
  )
