import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Application } from '../lib/application'
import { Provider } from '../lib/container'
// import { Module } from '../lib/module'
import { TestExtension, TestTransport, testApp } from './_utils'

describe.sequential('Application', () => {
  let app: Application

  beforeEach(async () => {
    app = testApp()
    await app.initialize()
    app.withTransport(TestTransport)
  })

  afterEach(async () => {
    await app.terminate()
  })

  it('should be an application', () => {
    expect(app).toBeDefined()
    expect(app).instanceOf(Application)
  })

  it('should register extension', () => {
    const newApp = app.withExtension(TestExtension)
    expect(newApp).toBe(app)
    for (const appExtension of app.extensions) {
      expect(appExtension).toBeInstanceOf(TestExtension)
      expect(appExtension).toHaveProperty(
        'application',
        expect.objectContaining({
          type: app.options.type,
          api: app.api,
          connections: {
            add: expect.any(Function),
            get: expect.any(Function),
            remove: expect.any(Function),
          },
          container: app.container,
          registry: app.registry,
          logger: expect.any(Object),
        }),
      )
    }
  })

  it('should register transport', () => {
    const newApp = app.withTransport(TestTransport)
    expect(newApp).toBe(app)
    const appTransport = app.transports.values().next().value
    expect(appTransport).toBeInstanceOf(TestTransport)
  })

  it('should register app context', async () => {
    const provider = new Provider()
      .withDependencies({
        logger: Application.logger,
        execute: Application.execute,
        eventManager: Application.eventManager,
      })
      .withFactory((dependencies) => dependencies)

    const ctx = await app.container.resolve(provider)

    expect(ctx).toBeDefined()
    expect(ctx).toHaveProperty('logger', app.logger)
    expect(ctx).toHaveProperty('execute', expect.any(Function))
    expect(ctx).toHaveProperty('eventManager', app.eventManager)
  })
})
