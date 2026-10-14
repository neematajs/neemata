import { describe, test } from 'vitest'

import type { Engine, Target } from './engine.ts'
import { engine as connect } from './engine.ts'
import { measure, options, publish, sample, specs } from './measure.ts'

// Each store is measured when its URL is given:
//
//   POSTGRES_URL=... REDIS_URL=... VALKEY_URL=... pnpm bench:integration
//
// The engine works in the schema `workflows_bench` and under the key prefix
// `workflows-bench:`, which it creates and removes.
const { POSTGRES_URL, REDIS_URL, VALKEY_URL } = process.env
const targets: readonly [name: string, target: Target | undefined][] = [
  [
    'postgres',
    POSTGRES_URL ? { store: 'postgres', url: POSTGRES_URL } : undefined,
  ],
  ['redis', REDIS_URL ? { store: 'redis', url: REDIS_URL } : undefined],
  ['valkey', VALKEY_URL ? { store: 'redis', url: VALKEY_URL } : undefined],
]

if (process.env.NMTJS_REQUIRE_SERVICE_TESTS === '1') {
  const missing = targets.filter(([, target]) => !target).map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(`No URL for the benchmark stores: ${missing.join(', ')}`)
  }
}

// A few quick specs on each store, as the cases of the paired benchmark
// runner: one iteration is one sample.
const QUICK = ['start', 'sequential-c8', 'map-100']

for (const [name, target] of targets) {
  test.skipIf(!target)(`workflow engine, ${name}`, async ({ bench }) => {
    let engine: Engine | undefined
    try {
      engine = await connect(target!)
      for (const spec of specs(1).filter(({ id }) => QUICK.includes(id))) {
        await bench(
          spec.title,
          { beforeEach: () => engine!.reset() },
          async () => {
            await sample(engine!, spec)
          },
        ).run({ time: 0, warmupTime: 0, iterations: 5, warmupIterations: 1 })
      }
    } finally {
      await engine?.dispose()
    }
  })
}

// Every spec, timed and then counted through the wire-counting proxy: a
// report rather than a regression case. A store takes about an hour, so it
// runs only when asked for:
//
//   WORKFLOWS_BENCH_REPORT=1 POSTGRES_URL=... pnpm bench:integration packages/workflows/bench
describe.skipIf(process.env.WORKFLOWS_BENCH_REPORT !== '1')('report', () => {
  for (const [name, target] of targets) {
    test.skipIf(!target)(
      name,
      async () => {
        await publish(await measure(name, target!, options()))
      },
      // Longer than the configured 30 minutes: a store takes about an hour.
      4 * 60 * 60 * 1_000,
    )
  }
})
