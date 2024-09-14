import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Application } from '../lib/application.ts'
import { builtin } from '../lib/common.ts'
import {
  Subscription,
  type SubscriptionManager,
  basicSubManagerPlugin,
} from '../lib/subscription.ts'
import { TestServiceContract, testApp, testLogger } from './_utils.ts'

describe.sequential('Basic subscription manager', () => {
  let subManager: SubscriptionManager
  let app: Application
  const contract = TestServiceContract.procedures.testSubscription

  beforeEach(async () => {
    app = testApp().use(basicSubManagerPlugin)
    await app.initialize()
    subManager = await app.container.resolve(builtin.subManager)
  })

  it('should initialize', async () => {
    expect(subManager).toBeDefined()
    expect(subManager).toMatchObject({
      publish: expect.any(Function),
      subscribe: expect.any(Function),
      unsubscribe: expect.any(Function),
      serialize: expect.any(Function),
    })
  })

  it('should subscribe', async () => {
    const subscription = new Subscription(contract, 'test', () => {})
    subManager.subscribe(subscription)
  })

  it('should unsubscribe', async () => {
    const subscription = new Subscription(contract, 'test', () => {})
    subManager.unsubscribe(subscription)
  })

  it('should publish', async () => {
    const subscription = new Subscription(contract, 'test', () => {})
    subManager.subscribe(subscription)
    const spy = vi.fn()
    subscription.on('event', spy)
    const args = ['testEvent', { test: 'data' }] as const
    subManager.publish('test', ...args)
    subManager.unsubscribe(subscription)
    subManager.publish('test', ...args)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(...args)
  })
})
