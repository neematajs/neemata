import { it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'

import type { StoreHarness } from './store-contract.ts'
import { makeInMemoryStore } from '../src/memory.ts'
import { mapPlans } from './map-plans.ts'
import { storeContract } from './store-contract.ts'
import { unitPlans } from './unit-plans.ts'

const harness: StoreHarness<never> = {
  make: (options) =>
    // The writer in a gap reads the clock of the test, as the store does.
    Effect.map(Effect.context<never>(), (context) => {
      let act: Effect.Effect<unknown> | undefined
      const { store } = makeInMemoryStore({
        ...options,
        beforeCommit: () => {
          const pending = act
          act = undefined
          if (pending) Effect.runSyncWith(context)(pending)
        },
      })
      return {
        store,
        // Nothing waits here: the writer has ended when the plan commits.
        inGap: (pending) => {
          act = pending
          return Effect.succeed(false)
        },
      }
    }),
  elapse: (ms) => TestClock.adjust(ms),
  hints: true,
  gap: true,
}

storeContract(it, harness)
unitPlans(it, harness)
mapPlans(it, harness)
