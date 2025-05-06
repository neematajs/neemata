import { CoreInjectables } from '@nmtjs/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '../src/application.ts'
import { AppInjectables } from '../src/injectables.ts'
import { testApp, testPlugin } from './_utils.ts'

describe('Application', () => {
  let app: Application

  beforeEach(async () => {
    app = testApp()
  })

  afterEach(async () => {
    await app.terminate()
  })

  it('should be an application', () => {
    expect(app).toBeDefined()
    expect(app instanceof Application).toBe(true)
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
    const logger = await app.container.resolve(CoreInjectables.logger)
    expect(logger).toBe(app.logger)
    const execute = await app.container.resolve(AppInjectables.execute)
    expect(typeof execute === 'function').toBe(true)
  })
})
