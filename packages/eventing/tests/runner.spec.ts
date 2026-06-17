import { EventContract, SubscriptionContract } from '@nmtjs/contract'
import { Container, CoreInjectables, createValueInjectable } from '@nmtjs/core'
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
import { implement } from '../src/index.ts'
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
    const handler: AnyEventingConsumerDefinition['handler'] = vi.fn(
      async (_ctx, event) => {
        handledEvents.push(event)
      },
    )
    const definition: AnyEventingConsumerDefinition = {
      message: event,
      groupId: 'users-service',
      from: 'earliest',
      handler,
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
      expect(handler).not.toHaveBeenCalled()

      const message: EventingAdapterMessage = {
        topic: 'users',
        name: event.event,
        key: 'user-1',
        payload: { id: 'user-1' },
        headers: { source: 'test' },
      }
      await adapter.handler?.(message)

      expect(handler).toHaveBeenCalledOnce()
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

  it('rejects duplicate single-event consumers for the same topic and group', async () => {
    const stream = SubscriptionContract({
      namespace: 'users',
      events: {
        userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
        userDeleted: EventContract({ payload: t.object({ id: t.string() }) }),
      },
    })
    const createdDefinition: AnyEventingConsumerDefinition = {
      message: stream.events.userCreated,
      groupId: 'users-service',
      handler: vi.fn(async () => {}),
    }
    const deletedDefinition: AnyEventingConsumerDefinition = {
      message: stream.events.userDeleted,
      groupId: 'users-service',
      handler: vi.fn(async () => {}),
    }
    const container = new Container({ logger: createTestLogger('parent') })
    const adapter = new TestEventingAdapter()
    const runner = new EventingRunner(
      { logger: createTestLogger('root'), container },
      { adapter },
    )

    try {
      await expect(
        runner.start({ consumers: [createdDefinition, deletedDefinition] }),
      ).rejects.toThrow(
        'Duplicate eventing consumer for topic [users] and group [users-service]',
      )
    } finally {
      await runner.stop()
      await container.dispose()
    }
  })

  it('dispatches subscription consumers with explicit dependency context', async () => {
    const stream = SubscriptionContract({
      namespace: 'users',
      events: {
        userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
        userCompleted: EventContract({
          payload: t.object({ ok: t.boolean() }),
        }),
      },
    })
    const events = implement(stream)
    const prefix = createValueInjectable('user')
    const handled: unknown[] = []
    const explicitLoggerLabels: unknown[] = []
    const definition = events(
      {
        userCreated: events.userCreated({
          dependencies: { prefix },
          async handler(ctx, event) {
            handled.push({
              event,
              prefix: ctx.prefix,
              hasLogger: Object.hasOwn(ctx, 'logger'),
            })
          },
        }),
        userCompleted: events.userCompleted({
          dependencies: { logger: CoreInjectables.logger },
          async handler(ctx, event) {
            explicitLoggerLabels.push(ctx.logger.bindings().$label)
            handled.push(event)
          },
        }),
      },
      { groupId: 'users-service', from: 'earliest' },
    )
    const container = new Container({ logger: createTestLogger('parent') })
    const adapter = new TestEventingAdapter()
    const runner = new EventingRunner(
      { logger: createTestLogger('root'), container },
      { adapter },
    )

    try {
      await runner.start({ consumers: [definition], consumerId: 'worker-1' })

      expect(adapter.consumeOptions).toMatchObject({
        topics: ['users'],
        groupId: 'users-service',
        consumerId: 'worker-1',
        from: 'earliest',
      })

      await adapter.handler?.({
        topic: 'users',
        name: 'unknown',
        payload: {},
        headers: {},
      })
      expect(handled).toEqual([])

      await adapter.handler?.({
        topic: 'users',
        name: 'userCreated',
        key: 'user-1',
        payload: { id: 'user-1' },
        headers: { source: 'test' },
      })
      await adapter.handler?.({
        topic: 'users',
        name: 'userCompleted',
        payload: { ok: true },
        headers: {},
      })

      expect(handled).toEqual([
        {
          prefix: 'user',
          hasLogger: false,
          event: {
            namespace: 'users',
            event: 'userCreated',
            key: 'user-1',
            payload: { id: 'user-1' },
            headers: { source: 'test' },
          },
        },
        {
          namespace: 'users',
          event: 'userCompleted',
          key: undefined,
          payload: { ok: true },
          headers: {},
        },
      ])
      expect(explicitLoggerLabels).toEqual(['EventingRunner'])
    } finally {
      await runner.stop()
      await container.dispose()
    }
  })

  it('fails unhandled subscription messages when configured', async () => {
    const stream = SubscriptionContract({
      namespace: 'users',
      events: {
        userCreated: EventContract({ payload: t.object({ id: t.string() }) }),
      },
    })
    const events = implement(stream)
    const definition = events(
      { userCreated: events.userCreated(async () => {}) },
      { groupId: 'users-service', unhandled: 'fail' },
    )
    const container = new Container({ logger: createTestLogger('parent') })
    const adapter = new TestEventingAdapter()
    const runner = new EventingRunner(
      { logger: createTestLogger('root'), container },
      { adapter },
    )

    try {
      await runner.start({ consumers: [definition] })

      await expect(
        adapter.handler?.({
          topic: 'users',
          name: 'unknown',
          payload: {},
          headers: {},
        }),
      ).rejects.toThrow('Unhandled eventing message [unknown]')
    } finally {
      await runner.stop()
      await container.dispose()
    }
  })
})
