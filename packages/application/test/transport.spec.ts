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
  let startSpy: Mock
  let stopSpy: Mock

  beforeEach(async () => {
    initSpy = vi.fn()
    startSpy = vi.fn()
    stopSpy = vi.fn()

    app = testApp().use(testTransport(initSpy, startSpy, stopSpy))
  })

  it('should start and stop', async () => {
    await app.start()
    expect(initSpy).toHaveBeenCalledOnce()
    expect(startSpy).toHaveBeenCalledOnce()
    await app.stop()
    expect(stopSpy).toHaveBeenCalledOnce()
  })
})

describe.sequential('Connection', () => {
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
