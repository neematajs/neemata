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
        job: expect.any(Function),
        step: expect.any(Function),
        jobRouter: expect.any(Function),
        jobOperation: expect.any(Function),
        jobsPlugin: expect.any(Function),
        pubsubPlugin: expect.any(Function),
        eventingPlugin: expect.any(Function),
        implementSubscription: expect.any(Function),
        blobType: expect.any(Function),
        c: expect.any(Object),
        t: expect.any(Object),
        CoreInjectables: expect.any(Object),
        GatewayInjectables: expect.any(Object),
        JobInjectables: expect.any(Object),
        PubSubInjectables: expect.any(Object),
        EventingInjectables: expect.any(Object),
        inject: expect.any(Object),
        logging: expect.any(Object),
      }),
    )

    const expectedInjectables = {
      ...mod.CoreInjectables,
      ...mod.GatewayInjectables,
      ...mod.JobInjectables,
      ...mod.PubSubInjectables,
      ...mod.EventingInjectables,
    }

    expect(mod.logging).toEqual({ console: expect.any(Function) })
    expect(mod.inject).toEqual(expect.objectContaining(expectedInjectables))
  })
})
