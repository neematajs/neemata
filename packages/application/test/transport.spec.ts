import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Application } from '../lib/application.ts'
import type { Service } from '../lib/service.ts'
import {
  type TestConnection,
  type TestServiceContract,
  TestTransport,
  testApp,
  testConnection,
  testService,
} from './_utils.ts'

describe.sequential('Transport', () => {
  let app: Application
  let transport: TestTransport
  let connection: TestConnection<any>

  beforeEach(async () => {
    app = testApp().withTransport(TestTransport)
    await app.initialize()
    for (const t of app.transports) transport = t as TestTransport
    connection = testConnection(app.registry)
  })

  it('should start and stop', async () => {
    const startSpy = vi.spyOn(transport, 'start')
    const stopSpy = vi.spyOn(transport, 'stop')
    await app.start()
    expect(startSpy).toHaveBeenCalledOnce()
    await app.stop()
    expect(stopSpy).toHaveBeenCalledOnce()
  })

  it('should add connection', async () => {
    transport.application.connections.add(connection)
    expect(app.connections.size).toBe(1)
  })

  it('should remove connection', async () => {
    transport.application.connections.add(connection)
    expect(app.connections.size).toBe(1)
    transport.application.connections.remove(connection)
    expect(app.connections.size).toBe(0)
  })

  it('should remove connection by id', async () => {
    transport.application.connections.add(connection)
    expect(app.connections.size).toBe(1)
    transport.application.connections.remove(connection.id)
    expect(app.connections.size).toBe(0)
  })

  it('should get connection', async () => {
    transport.application.connections.add(connection)
    expect(transport.application.connections.get(connection.id)).toBe(
      connection,
    )
  })
})

describe.sequential('Transport connection', () => {
  let app: Application
  let service: Service<typeof TestServiceContract>
  let transport: TestTransport

  beforeEach(async () => {
    service = testService()
    app = testApp().withServices(service).withTransport(TestTransport)

    await app.initialize()
    for (const t of app.transports) transport = t as TestTransport
  })

  it('should send event', async () => {
    const connection = testConnection(app.registry)
    transport.application.connections.add(connection)
    const payload = 'test'
    const sendSpy = vi.spyOn(connection, 'sendEvent' as any)
    connection.notify(service.contract, 'testEvent', payload)
    expect(sendSpy).toHaveBeenCalledWith(
      service.contract.name,
      'testEvent',
      payload,
    )
  })
})
