import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Application } from '../lib/application.ts'
import type { Connection } from '../lib/connection.ts'
import { Registry } from '../lib/registry.ts'
import type { Service } from '../lib/service.ts'
import {
  type TestServiceContract,
  testApp,
  testConnection,
  testLogger,
  testService,
  testTransport,
} from './_utils.ts'

describe.sequential('Transport', () => {
  let app: Application
  let initSpy: Mock
  let startupSpy: Mock
  let shutdownSpy: Mock

  beforeEach(async () => {
    initSpy = vi.fn()
    startupSpy = vi.fn()
    shutdownSpy = vi.fn()

    app = testApp().use(testTransport(initSpy, startupSpy, shutdownSpy))
    await app.initialize()
  })

  it('should start and stop', async () => {
    expect(initSpy).toHaveBeenCalledOnce()
    await app.startup()
    expect(startupSpy).toHaveBeenCalledOnce()
    await app.shutdown()
    expect(shutdownSpy).toHaveBeenCalledOnce()
  })
})

describe.sequential('Connection', () => {
  let app: Application
  let service: Service<typeof TestServiceContract>
  let connection: Connection
  let sendEventSpy: Mock

  beforeEach(async () => {
    service = testService()
    const logger = testLogger()
    const registry = new Registry({ logger })
    registry.registerService(service)
    sendEventSpy = vi.fn()
    connection = testConnection(registry, { sendEvent: sendEventSpy })
  })

  it('should init', () => {
    expect(connection).toBeDefined()
    expect(connection.id).toBeTypeOf('string')
    expect(connection.type).toBe('test')
    expect(connection.services).toBeInstanceOf(Set)
    expect(Array.from(connection.services)).toStrictEqual([
      service.contract.name,
    ])
    expect(connection.subscriptions).toBeInstanceOf(Map)
  })

  it('should send event', () => {
    const payload = 'test'
    connection.notify(service.contract, 'testEvent', payload)
    expect(sendEventSpy).toHaveBeenCalledWith(
      service.contract.name,
      'testEvent',
      payload,
    )
  })
})
