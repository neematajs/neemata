import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerType } from '../lib/constants'
import {
  BaseSubscriptionManager,
  BasicSubscriptionManager,
  Subscription,
} from '../lib/subscription'
import { testLogger } from './_utils'

describe.sequential('Basic subscription manager', () => {
  let subManager: BaseSubscriptionManager

  beforeEach(() => {
    const logger = testLogger()
    // @ts-expect-error
    subManager = new BasicSubscriptionManager({ logger, type: WorkerType.Api })
  })

  it('should initialize', async () => {
    expect(subManager).toBeDefined()
    expect(subManager).toBeInstanceOf(BaseSubscriptionManager)
  })

  it('should subscribe', async () => {
    const subscription = new Subscription('test')
    subManager.subscribe(subscription)
  })

  it('should unsubscribe', async () => {
    const subscription = new Subscription('test')
    subManager.unsubscribe(subscription)
  })

  it('should publish', async () => {
    const subscription = new Subscription('test')
    subManager.subscribe(subscription)
    const spy = vi.fn()
    subscription.on('neemata:event', spy)
    const args = ['event', { test: 'data' }] as const
    subManager.publish('test', ...args)
    subManager.unsubscribe(subscription)
    subManager.publish('test', ...args)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith(...args)
  })
})
