import { describe, layer } from '@effect/vitest'

import { mapPlans } from '../map-plans.ts'
import { client, harness, SERVERS } from '../redis-support.ts'
import { storeContract } from '../store-contract.ts'
import { unitPlans } from '../unit-plans.ts'

// The server's clock is the real one, so these tests wait where the
// in-memory store's move a test clock.
const options = { excludeTestServices: true, timeout: '60 seconds' } as const

for (const [server, url] of SERVERS) {
  describe.skipIf(!url)(`the store contract on ${server}`, () => {
    layer(
      client(url!),
      options,
    )((it) => {
      storeContract(it, harness)
      unitPlans(it, harness)
      mapPlans(it, harness)
    })
  })
}
