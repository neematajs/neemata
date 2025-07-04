import { defer } from '@nmtjs/common'
import { c } from '@nmtjs/contract'
import { Container, Hook } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppInjectables } from '../src/injectables.ts'
import {
  PubSub,
  type PubSubAdapter,
  type PubSubAdapterEvent,
} from '../src/pubsub.ts'
import { ApplicationRegistry } from '../src/registry.ts'
import { testLogger } from './_utils.ts'

// Test contracts
const TestSubscriptionContract1 = c
  .subscription({
    name: 'TestSubscription1',
    events: {
      testEvent: c.event({
        payload: t.object({
          message: t.string(),
          timestamp: t.number(),
        }),
      }),
      anotherEvent: c.event({
        payload: t.string(),
      }),
    },
  })
  .$withOptions<{ userId: string }>()

const TestSubscriptionContract2 = c
  .subscription({
    name: 'TestSubscription2',
    events: {
      testEvent: c.event({
        payload: t.object({
          message: t.string(),
          timestamp: t.number(),
        }),
      }),
      transformEvent: c.event({
        payload: t.date(),
      }),
    },
  })
  .$withOptions<{ userId: string }>()

// Mock adapter for testing
class MockPubSubAdapter implements PubSubAdapter {
  private subscribeGen:
    | ((channel: string) => AsyncGenerator<PubSubAdapterEvent, void, unknown>)
    | null = null

  async publish(channel: string, payload: any): Promise<boolean> {
    return true
  }

  async *subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<{ channel: string; payload: any }> {
    if (this.subscribeGen) {
      yield* this.subscribeGen(channel)
    }
  }

  // Test helpers
  setSubscribeGenerator(
    gen: (channel: string) => AsyncGenerator<PubSubAdapterEvent, void, unknown>,
  ) {
    this.subscribeGen = gen
  }
}

describe('PubSub', () => {
  const logger = testLogger()
  let registry: ApplicationRegistry
  let container: Container
  let pubsub: PubSub
  let adapter: MockPubSubAdapter

  beforeEach(async () => {
    adapter = new MockPubSubAdapter()
    registry = new ApplicationRegistry({
      logger,
    })
    container = new Container({
      logger,
      registry,
    })
    container.provide(AppInjectables.pubsubAdapter, adapter)
    pubsub = new PubSub(
      {
        logger,
        registry,
        container,
      },
      {
        adapter,
      },
    )
  })

  afterEach(async () => {
    await registry.hooks.call(Hook.BeforeTerminate, {})
  })

  it('should subscribe to specific events', async () => {
    const testData = {
      event: 'testEvent',
      data: {
        message: 'Hello World',
        timestamp: Date.now(),
      },
    }

    // Create a generator that yields test data
    async function* mockGenerator(channel: string) {
      yield {
        channel,
        payload: testData.data,
      }
    }

    adapter.setSubscribeGenerator(mockGenerator)

    const subscription = pubsub.subscribe(
      TestSubscriptionContract1,
      { testEvent: true },
      { userId: 'user1' },
    )

    const result = await subscription[Symbol.asyncIterator]().next()
    expect(result.done).toBe(false)
    expect(result.value).toMatchObject(testData)
  })

  it('should handle multiple events in subscription', async () => {
    const testData = {
      event: 'anotherEvent',
      data: 'Hello Again',
    }

    // Create a generator that yields test data
    async function* mockGenerator(channel: string) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      yield {
        channel,
        payload: testData.data,
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      yield {
        channel,
        payload: testData.data,
      }
    }

    // type a = t.infer.decoded.input<typeof TestSubscriptionContract2.events.transformEvent.payload>
    adapter.setSubscribeGenerator(mockGenerator)

    const subscription = pubsub.subscribe(
      TestSubscriptionContract1,
      { anotherEvent: true },
      { userId: 'user1' },
    )
    expect(pubsub.subscriptions.size).toBe(1)

    let count = 0

    for await (const { event, data } of subscription) {
      expect(event).toBe(testData.event)
      expect(data).toBe(testData.data)
      count++
    }

    expect(count).toBe(2)

    expect(pubsub.subscriptions.size).toBe(0)
  })

  it('should publish events', async () => {
    const testData = {
      event: 'testEvent',
      data: {
        message: 'Hello World',
        timestamp: Date.now(),
      },
    }

    // Create a generator that yields test data
    async function* mockGenerator(channel: string) {
      yield {
        channel,
        payload: testData.data,
      }
    }

    adapter.setSubscribeGenerator(mockGenerator)

    const subscription = pubsub.subscribe(
      TestSubscriptionContract1,
      { testEvent: true },
      { userId: 'user1' },
    )

    const publishResult = await pubsub.publish(
      TestSubscriptionContract1,
      TestSubscriptionContract1.events.testEvent,
      { userId: 'user1' },
      testData.data,
    )

    expect(publishResult).toBe(true)

    const result = await subscription[Symbol.asyncIterator]().next()
    expect(result.done).toBe(false)
    expect(result.value).toMatchObject(testData)
  })

  it('should handle multiple subscriptions', async () => {
    const testData1 = {
      event: 'testEvent',
      data: {
        message: 'Hello World',
        timestamp: Date.now(),
      },
    }

    const testData2 = {
      event: 'transformEvent',
      data: new Date(),
    }

    // Create a generator that yields test data
    async function* mockGenerator(channel: string) {
      if (channel.startsWith(TestSubscriptionContract1.name)) {
        yield {
          channel,
          payload: testData1.data,
        }
      } else if (channel.startsWith(TestSubscriptionContract2.name)) {
        yield {
          channel,
          payload: testData2.data.toISOString(),
        }
      }
    }

    adapter.setSubscribeGenerator(mockGenerator)

    const subscription1 = pubsub.subscribe(
      TestSubscriptionContract1,
      { testEvent: true },
      { userId: 'user1' },
    )

    const subscription2 = pubsub.subscribe(
      TestSubscriptionContract2,
      { transformEvent: true },
      { userId: 'user2' },
    )

    expect(pubsub.subscriptions.size).toBe(2)

    for await (const { event, data } of subscription1) {
      expect(event).toBe(testData1.event)
      expect(data).toMatchObject(testData1.data)
    }

    for await (const { event, data } of subscription2) {
      expect(event).toBe(testData2.event)
      expect(data).toBeInstanceOf(Date)
      expect(data.toISOString()).toBe(testData2.data.toISOString())
    }

    expect(pubsub.subscriptions.size).toBe(0)
  })

  it('should properly handle subscription options', async () => {
    const options1 = { userId: 'user1' }
    const options2 = { userId: 'user2' }

    const subscription1 = pubsub.subscribe(
      TestSubscriptionContract1,
      { testEvent: true },
      options1,
    )
    const subscription2 = pubsub.subscribe(
      TestSubscriptionContract1,
      { testEvent: true },
      options2,
    )

    adapter.setSubscribeGenerator(async function* (channel) {
      if (channel.startsWith(TestSubscriptionContract1.name)) {
        yield {
          channel,
          payload: { message: 'Hello World', timestamp: Date.now() },
        }
      }
    })

    expect(pubsub.subscriptions.size).toBe(2)

    let count1 = 0
    let count2 = 0

    const result = defer(async () => {
      for await (const { event, data } of subscription1) {
        expect(event).toBe('testEvent')
        expect(data).toHaveProperty('message')
        expect(data).toHaveProperty('timestamp')
        count1++
      }

      for await (const { event, data } of subscription2) {
        expect(event).toBe('testEvent')
        expect(data).toHaveProperty('message')
        expect(data).toHaveProperty('timestamp')
        count2++
      }
    }, 1)

    pubsub.publish(
      TestSubscriptionContract1,
      TestSubscriptionContract1.events.testEvent,
      options1,
      { message: 'Hello World', timestamp: Date.now() },
    )

    pubsub.publish(
      TestSubscriptionContract1,
      TestSubscriptionContract1.events.testEvent,
      options2,
      { message: 'Hello Again', timestamp: Date.now() },
    )

    await expect(result).resolves.not.toThrow()

    expect(count1).toBe(1)
    expect(count2).toBe(1)

    expect(pubsub.subscriptions.size).toBe(0)
  })
})
