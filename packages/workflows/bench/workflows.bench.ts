import { describe, test } from 'vitest'

import type { Engine } from './engine.ts'
import { engine as connect } from './engine.ts'
import { measure, options, publish, sample, specs } from './measure.ts'

// The quick specs of the harness, on the in-memory store, as the regression
// cases of the paired benchmark runner: one iteration is one sample.
const QUICK = ['start', 'sequential-c8', 'tasks', 'parallel', 'map-100']

test('workflow engine, in memory', async ({ bench }) => {
  let engine: Engine | undefined
  try {
    engine = await connect({ store: 'memory' })
    for (const spec of specs(1).filter(({ id }) => QUICK.includes(id))) {
      await bench(
        spec.title,
        { beforeEach: () => engine!.reset() },
        async () => {
          await sample(engine!, spec)
        },
      ).run({ time: 0, warmupTime: 0, iterations: 50, warmupIterations: 5 })
    }
  } finally {
    await engine?.dispose()
  }
})

// Every spec, timed over rounds, with the workers' idle cost: a report rather
// than a regression case. It takes minutes, so it runs only when asked for:
//
//   WORKFLOWS_BENCH_REPORT=1 pnpm bench packages/workflows/bench
describe.skipIf(process.env.WORKFLOWS_BENCH_REPORT !== '1')('report', () => {
  test(
    'memory',
    async () => {
      await publish(
        await measure('memory', { store: 'memory' }, options({ scale: 10 })),
      )
    },
    // Longer than the configured 30 minutes: a measurement takes what it takes.
    4 * 60 * 60 * 1_000,
  )
})
