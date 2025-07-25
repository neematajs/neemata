import { CoreInjectables } from '@nmtjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '../src/application.ts'
import { AppInjectables } from '../src/injectables.ts'
import { PubSub } from '../src/pubsub.ts'
import { testApp, testPlugin } from './_utils.ts'

describe.sequential('Application', () => {
  let app: Application

  beforeEach(async () => {
    app = testApp()
  })

  afterEach(async () => {
    await app.terminate()
  })

  it('should be an application', () => {
    expect(app).toBeDefined()
    expect(app).instanceOf(Application)
  })

  it('should register plugin', async () => {
    const spy = vi.fn()
    const plugin = testPlugin(spy)
    const newApp = app.use(plugin)

    expect(newApp).toBe(app)
    await app.initialize()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: app.options.type,
        api: app.api,
        format: app.format,
        container: app.container,
        logger: expect.anything(),
        registry: app.registry,
        hooks: app.registry.hooks,
        protocol: app.protocol,
      }),
      undefined,
    )
  })

  it('should register app injections', async () => {
    await expect(app.container.resolve(CoreInjectables.logger)).resolves.toBe(
      app.logger,
    )
    await expect(
      app.container.resolve(AppInjectables.execute),
    ).resolves.toBeInstanceOf(Function)

    await expect(
      app.container.resolve(AppInjectables.pubsub),
    ).resolves.toBeInstanceOf(PubSub)

    await expect(
      app.container.resolve(AppInjectables.pubsubAdapter),
    ).rejects.toThrow()
  })
})
