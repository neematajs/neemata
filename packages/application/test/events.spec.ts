import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerType } from '../lib/constants'
import { EventManager } from '../lib/events'
import { Registry } from '../lib/registry'
import type { Service } from '../lib/service'
import { BasicSubscriptionManager } from '../lib/subscription'
import type { BaseTransportConnection } from '../lib/transport'
import {
  type TestServiceContract,
  testConnection,
  testLogger,
  testService,
} from './_utils'

describe.sequential('Event manager', () => {
  let service: Service<typeof TestServiceContract>
  let manager: EventManager
  let connection: BaseTransportConnection

  let options: [
    typeof service.contract,
    'testSubscription',
    { testOption: 'test' },
    typeof connection,
  ]

  beforeEach(() => {
    const logger = testLogger()
    const registry = new Registry({ logger })
    service = testService()
    registry.registerService(service)
    const subManager = new BasicSubscriptionManager(
      // @ts-expect-error
      { logger, type: WorkerType.Api },
      undefined,
    )
    manager = new EventManager({ registry, subManager, logger })
    connection = testConnection(registry)

    options = [
      service.contract,
      'testSubscription',
      { testOption: 'test' },
      connection,
    ]
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
    subscription.on('neemata:event', spy)
    manager.publish(options[0], options[1], options[2], event, payload)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(event, payload)
  })
})
