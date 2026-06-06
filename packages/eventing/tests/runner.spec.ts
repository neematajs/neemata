import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { Container } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it, vi } from 'vitest'

import type {
  EventingAdapter,
  EventingAdapterConsumeOptions,
  EventingAdapterMessage,
  EventingAdapterMessageHandler,
  EventingConsumer,
} from '../src/core/adapter.ts'
import type { AnyEventingConsumerDefinition } from '../src/core/consumer.ts'
import { EventingRunner } from '../src/core/runner.ts'
import { createTestLogger } from './integration/helpers.ts'

class TestEventingAdapter implements EventingAdapter {
  readonly initialize = vi.fn(async () => {})
  readonly dispose = vi.fn(async () => {})
  readonly produce = vi.fn(async () => {})
  readonly close = vi.fn(async () => {})
  consumeOptions?: EventingAdapterConsumeOptions
  handler?: EventingAdapterMessageHandler

  async consume(
    options: EventingAdapterConsumeOptions,
    handler: EventingAdapterMessageHandler,
  ): Promise<EventingConsumer> {
    this.consumeOptions = options
    this.handler = handler

    return { close: this.close, closed: new Promise(() => {}) }
  }
}

describe('EventingRunner', () => {
  it('starts consumers through the adapter and handles matching events', async () => {
    const stream = SubscriptionContract({
      namespace: 'users',
      params: t.object({ id: t.string() }),
      key: ({ id }) => id,
      events: {
        userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
      },
    })
    const event = stream.events.userCreated
    const handledEvents: unknown[] = []
    const handle: AnyEventingConsumerDefinition['handle'] = vi.fn(
      async (_ctx, event) => {
        handledEvents.push(event)
      },
    )
    const definition: AnyEventingConsumerDefinition = {
      message: event,
      groupId: 'users-service',
      from: 'earliest',
      handle,
    }
    const container = new Container({ logger: createTestLogger('parent') })
    const adapter = new TestEventingAdapter()
    const runner = new EventingRunner(
      { logger: createTestLogger('root'), container },
      { adapter },
    )

    try {
      await runner.start({ consumers: [definition], consumerId: 'worker-1' })

      expect(runner.container).not.toBe(container)
      expect(runner.logger.bindings()).toHaveProperty(
        '$label',
        'EventingRunner',
      )
      expect(adapter.initialize).toHaveBeenCalledOnce()
      expect(adapter.consumeOptions).toMatchObject({
        topics: ['users'],
        groupId: 'users-service',
        consumerId: 'worker-1',
        from: 'earliest',
      })

      const ignoredMessage: EventingAdapterMessage = {
        topic: 'users',
        name: 'userDeleted',
        key: 'user-1',
        payload: { id: 'user-1' },
        headers: {},
      }
      await adapter.handler?.(ignoredMessage)
      expect(handle).not.toHaveBeenCalled()

      const message: EventingAdapterMessage = {
        topic: 'users',
        name: event.event,
        key: 'user-1',
        payload: { id: 'user-1' },
        headers: { source: 'test' },
      }
      await adapter.handler?.(message)

      expect(handle).toHaveBeenCalledOnce()
      expect(handledEvents).toEqual([
        {
          namespace: 'users',
          event: event.event,
          key: 'user-1',
          payload: { id: 'user-1' },
          headers: { source: 'test' },
        },
      ])
    } finally {
      await runner.stop()
      await container.dispose()
    }

    expect(adapter.close).toHaveBeenCalledOnce()
    expect(adapter.dispose).toHaveBeenCalledOnce()
  })
})
