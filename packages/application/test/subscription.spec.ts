import { beforeEach, describe, expect, it } from 'vitest'
import type { Application } from '../lib/application'
import { BaseSubscriptionManager, type Subscription } from '../lib/subscription'
import { testApp } from './_utils'

class TestSubscriptionManager extends BaseSubscriptionManager {
  name = 'Test subscription manager'

  async subscribe(subscription: Subscription) {}

  async unsubscribe(subscription: Subscription): Promise<boolean> {
    return true
  }

  async publish(key: string, payload: any): Promise<boolean> {
    return true
  }
}

describe.sequential('Subscription manager', () => {
  let app: Application

  beforeEach(() => {
    app = testApp()
  })

  it('should initialize', async () => {
    app.withSubscriptionManager(TestSubscriptionManager)
    expect(app.subManager).toBeInstanceOf(TestSubscriptionManager)
    expect(app.subManager).toBeDefined()
  })
})
