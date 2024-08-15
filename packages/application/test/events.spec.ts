import { afterEach } from 'node:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Application } from '../lib/application.ts'
import type { Connection } from '../lib/connection.ts'
import { EventManager } from '../lib/events.ts'
import type { Service } from '../lib/service.ts'
import {
  type TestServiceContract,
  testApp,
  testConnection,
  testService,
} from './_utils.ts'

describe.sequential('Event manager', () => {
  let app: Application
  let service: Service<typeof TestServiceContract>
  let manager: EventManager
  let connection: Connection

  let options: [
    typeof service.contract.procedures.testSubscription,
    { testOption: 'test' },
    typeof connection,
  ]

  beforeEach(async () => {
    service = testService()
    app = testApp().withServices(service)
    manager = app.eventManager
    connection = testConnection(app.registry)

    options = [
      service.contract.procedures.testSubscription,
      { testOption: 'test' },
      connection,
    ]

    await app.initialize()
  })

  afterEach(async () => {
    await app.terminate()
  })

  it('should be an event manager', () => {
    expect(manager).toBeDefined()
    expect(manager).toBeInstanceOf(EventManager)
  })

  it('should subscribe', async () => {
    const { subscription, isNew } = await manager.subscribe(...options)
    expect(connection.subscriptions.size).toBe(1)
    expect(connection.subscriptions.get(subscription.key)).toBe(subscription)
    expect(isNew).toBe(true)
  })

  it('should unsubscribe from event', async () => {
    await manager.subscribe(...options)
    expect(connection.subscriptions.size).toBe(1)
    await manager.unsubscribe(...options)
    expect(connection.subscriptions.size).toBe(0)

    // unsubscribe by key
    const { subscription } = await manager.subscribe(...options)
    expect(connection.subscriptions.size).toBe(1)
    await manager.unsubscribeByKey(subscription.key, connection)
    expect(connection.subscriptions.size).toBe(0)
  })

  it('should return isSubscribed', async () => {
    await expect(manager.isSubscribed(...options)).resolves.toBe(false)
    await manager.subscribe(...options)
    await expect(manager.isSubscribed(...options)).resolves.toBe(true)
    await manager.unsubscribe(...options)
    await expect(manager.isSubscribed(...options)).resolves.toBe(false)
  })

  it('should return existing subscription', async () => {
    const sub1 = await manager.subscribe(...options)
    expect(sub1.isNew).toBe(true)
    const sub2 = await manager.subscribe(...options)
    expect(sub2.isNew).toBe(false)
    expect(sub1.subscription).toBe(sub2.subscription)
    expect(connection.subscriptions.size).toBe(1)
  })

  it('should publish event', async () => {
    const payload = 'test' as const
    const event = 'testEvent' as const
    const { subscription } = await manager.subscribe(...options)
    const spy = vi.fn()
    subscription.on('event', spy)
    manager.publish(options[0], options[1], event, payload)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(event, payload)
  })
})
