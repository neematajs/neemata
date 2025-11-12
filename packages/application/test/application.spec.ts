import { kRootRouter } from '@nmtjs/api'
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
    await app.dispose()
  })

  it('should be an application', () => {
    expect(app).toBeDefined()
    expect(app).instanceOf(Application)
  })

  it('should register plugin', async () => {
    const spy = vi.fn(() => ({}))
    const plugin = testPlugin(spy)
    app = testApp({ plugins: [{ plugin, options: undefined }] })

    await app.initialize()
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: app.type,
        api: app.api,
        format: app.format,
        container: app.container,
        logger: expect.anything(),
        registry: app.registry,
        hooks: app.hooks,
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
      app.container.resolve(AppInjectables.executeCommand),
    ).resolves.toBeInstanceOf(Function)

    await expect(
      app.container.resolve(AppInjectables.pubsub),
    ).resolves.toBeInstanceOf(PubSub)

    await expect(
      app.container.resolve(AppInjectables.pubsubAdapter),
    ).rejects.toThrow()
  })

  it("should register app's root router", async () => {
    await app.initialize()
    const rootRouter = app.registry.routers.get(kRootRouter)
    expect(rootRouter).toBeDefined()
    expect(rootRouter!.routes).toMatchObject(app.config.router!.routes)
  })
})
