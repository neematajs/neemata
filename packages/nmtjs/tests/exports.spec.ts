import { describe, expect, it } from 'vitest'

describe('nmtjs umbrella exports', () => {
  it('exposes the curated named export surface', async () => {
    const mod = await import('../src/index.ts')

    expect(mod).toEqual(
      expect.objectContaining({
        app: expect.any(Function),
        host: expect.any(Function),
        plugin: expect.any(Function),
        rootRouter: expect.any(Function),
        router: expect.any(Function),
        implementRouter: expect.any(Function),
        contractRouter: expect.any(Function),
        procedure: expect.any(Function),
        contractProcedure: expect.any(Function),
        middleware: expect.any(Function),
        meta: expect.any(Function),
        guard: expect.any(Function),
        filter: expect.any(Function),
        hook: expect.any(Function),
        value: expect.any(Function),
        lazy: expect.any(Function),
        optional: expect.any(Function),
        factory: expect.any(Function),
        transport: expect.any(Function),
        pubsubPlugin: expect.any(Function),
        blobType: expect.any(Function),
        workflow: expect.any(Function),
        task: expect.any(Function),
        schedule: expect.any(Function),
        implementWorkflow: expect.any(Function),
        implementTask: expect.any(Function),
        WorkflowAttemptTimeoutError: expect.any(Function),
        c: expect.any(Object),
        CoreInjectables: expect.any(Object),
        GatewayInjectables: expect.any(Object),
        PubSubInjectables: expect.any(Object),
        inject: expect.any(Object),
        logging: expect.any(Object),
        metrics: expect.objectContaining({
          counter: expect.any(Function),
          gauge: expect.any(Function),
          histogram: expect.any(Function),
          summary: expect.any(Function),
        }),
      }),
    )

    // t is a module namespace re-export (null prototype), which
    // expect.any(Object)'s instanceof check rejects — assert it structurally
    expect(mod.t).toBeTypeOf('object')
    expect(mod.t.object).toBeTypeOf('function')
    expect(mod.t.string).toBeTypeOf('function')

    const expectedInjectables = {
      ...mod.CoreInjectables,
      ...mod.GatewayInjectables,
      ...mod.PubSubInjectables,
    }
    const metricMod = await import('@nmtjs/metrics')

    expect(mod.logging).toEqual({ console: expect.any(Function) })
    expect(mod.metrics).toEqual({
      counter: metricMod.createCounterMetric,
      gauge: metricMod.createGaugeMetric,
      histogram: metricMod.createHistogramMetric,
      summary: metricMod.createSummaryMetric,
    })
    expect(mod.inject).toEqual(expect.objectContaining(expectedInjectables))
  })
})
