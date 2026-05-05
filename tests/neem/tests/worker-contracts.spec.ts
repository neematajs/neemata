import type {
  InferNeemWorkerData,
  NeemWorkerRuntimeContext,
} from '@nmtjs/neem/worker'
import { defineWorker } from '@nmtjs/neem/worker'
import { describe, expect, expectTypeOf, it } from 'vitest'

type FixtureWorkerData = { queue: string; concurrency?: number }

const worker = defineWorker<FixtureWorkerData, { fixture: true }>({
  kind: 'fixture-worker',
  definition: { fixture: true },
  createRuntime(ctx) {
    expectTypeOf(ctx).toEqualTypeOf<
      NeemWorkerRuntimeContext<FixtureWorkerData, { fixture: true }>
    >()
    return {
      start() {
        return undefined
      },
      stop() {},
      reload() {
        return undefined
      },
    }
  },
})

describe('@nmtjs/neem worker contract', () => {
  it('keeps worker data inferred from defineWorker', () => {
    type Data = InferNeemWorkerData<typeof worker>

    expectTypeOf<Data>().toEqualTypeOf<FixtureWorkerData>()
    expect(worker.kind).toBe('fixture-worker')
  })

  it('rejects invalid worker data at compile time', () => {
    const invalidData: InferNeemWorkerData<typeof worker> = {
      queue: 'jobs',
      // @ts-expect-error concurrency must stay numeric
      concurrency: '2',
    }

    expect(Boolean(invalidData)).toBe(true)
  })
})
