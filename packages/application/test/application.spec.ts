import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '../lib/application.ts'
import { injectables } from '../lib/injectables.ts'
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
        eventManager: app.eventManager,
        logger: expect.anything(),
        registry: app.registry,
        hooks: app.registry.hooks,
        connections: {
          add: expect.any(Function),
          remove: expect.any(Function),
          get: expect.any(Function),
        },
      }),
      undefined,
    )
  })

  it('should register app injections', async () => {
    expect(app.container.resolve(injectables.logger)).resolves.toBe(app.logger)
    expect(app.container.resolve(injectables.execute)).resolves.toBeInstanceOf(
      Function,
    )
    expect(app.container.resolve(injectables.eventManager)).resolves.toBe(
      app.eventManager,
    )
  })
})
