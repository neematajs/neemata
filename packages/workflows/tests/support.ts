import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import type {
  AttemptCommand,
  Claim,
  Outcome,
  Program,
  Registry,
} from '../src/index.ts'
import {
  coordinate,
  drain,
  InMemory,
  registry,
  settle,
  Store,
} from '../src/index.ts'

export const LEASE = 30_000

/** These tests settle attempts by hand; no handler runs. */
export const unused = () => Effect.die('not run')

export const completed = (output: unknown): Outcome => ({
  _tag: 'Completed',
  output,
})
export const failed = (message: string): Outcome => ({
  _tag: 'Failed',
  error: { message },
})

export function setup(
  programs: readonly Program[],
  options?: InMemory.InMemoryOptions,
) {
  const memory = InMemory.makeInMemoryStore(options)
  const served = registry(programs)
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Store, memory.store)

  return { ...memory, served, provide }
}

/**
 * Claims and runs every due coordination command once, and drains a run a
 * pass leaves cancelling, as a coordinator does; returns how many.
 */
export const pass = Effect.fnUntraced(function* (served: Registry) {
  const store = yield* Store
  const claims = yield* store.claim({
    lanes: [{ kind: 'continueRun', routes: served.workflows }],
    limit: 100,
    leaseMs: LEASE,
  })
  for (const claim of claims) {
    const result = yield* coordinate(served, claim)
    if (result._tag === 'Advanced' && result.draining) {
      yield* drain(result.draining)
    }
  }
  return claims.length
})

/** Claims every due attempt, of activities and of tasks. */
export const claimAttempts = Effect.fnUntraced(function* (
  served: Registry,
  leaseMs = LEASE,
) {
  const store = yield* Store
  const claims: readonly Claim<AttemptCommand>[] = yield* store.claim({
    lanes: [
      { kind: 'runAttempt', routes: served.workflows },
      { kind: 'runTask', routes: served.tasks },
    ],
    limit: 100,
    leaseMs,
  })
  return claims
})

/** Settles the one attempt that is due. */
export const work = Effect.fnUntraced(function* (
  served: Registry,
  outcome: Outcome,
) {
  const [claim, ...others] = yield* claimAttempts(served)
  if (!claim || others.length > 0) {
    return yield* Effect.die(
      `Expected one due attempt, found ${others.length + (claim ? 1 : 0)}`,
    )
  }
  return yield* settle(served, claim, outcome)
})

export const load = (runId: string) =>
  Effect.flatMap(Store, (store) => store.load(runId)).pipe(
    Effect.map((records) => records!),
  )

/**
 * Lets every fiber run that can without the clock moving. Waking another
 * fiber takes a turn of the scheduler, and no chain of wakes in these tests
 * is near this long.
 */
export const idle = Effect.gen(function* () {
  for (let turn = 0; turn < 100; turn++) yield* Effect.yieldNow
})

/**
 * Moves the clock in steps, letting the fibers settle after each: what a
 * worker does on waking then happens at the time that woke it.
 */
export const elapse = Effect.fnUntraced(function* (ms: number, stepMs = 1_000) {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    yield* TestClock.adjust(Math.min(stepMs, ms - elapsed))
    yield* idle
  }
})
