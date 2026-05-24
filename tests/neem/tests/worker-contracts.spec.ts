import type { InferNeemWorkerData, NeemWorkerRuntimeContext } from '@nmtjs/neem'
import { defineWorker } from '@nmtjs/neem'
import { describe, expect, expectTypeOf, it } from 'vitest'

type FixtureWorkerData = { queue: string; concurrency?: number }

const worker = defineWorker<FixtureWorkerData, { fixture: true }>({
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
    }
  },
})

describe('@nmtjs/neem worker contract', () => {
  it('keeps worker data inferred from defineWorker', () => {
    type Data = InferNeemWorkerData<typeof worker>

    expectTypeOf<Data>().toEqualTypeOf<FixtureWorkerData>()
    expect(worker.definition).toEqual({ fixture: true })
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
