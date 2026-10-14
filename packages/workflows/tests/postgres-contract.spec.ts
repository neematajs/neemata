import { describe, layer } from '@effect/vitest'

import { mapPlans } from './map-plans.ts'
import { harness, pglite, postgres, POSTGRES_URL } from './postgres-support.ts'
import { storeContract } from './store-contract.ts'
import { unitPlans } from './unit-plans.ts'

// The database's clock is the real one, so these tests wait where the
// in-memory store's move a test clock.
const options = { excludeTestServices: true, timeout: '60 seconds' } as const

layer(pglite, options)('the store contract on PGlite', (it) => {
  storeContract(it, harness('one'))
  unitPlans(it, harness('one'))
  mapPlans(it, harness('one'))
})

describe.skipIf(!POSTGRES_URL)('the store contract on PostgreSQL', () => {
  layer(
    postgres(POSTGRES_URL!),
    options,
  )((it) => {
    storeContract(it, harness('many'))
    unitPlans(it, harness('many'))
    mapPlans(it, harness('many'))
  })
})
