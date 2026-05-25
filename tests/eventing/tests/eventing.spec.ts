import type {
  EventingAdapter,
  EventingAdapterConsumeOptions,
  EventingAdapterMessage,
  EventingAdapterMessageHandler,
  EventingConsumer,
} from '@nmtjs/eventing'
import type { RedisStreamsEventingClient } from '@nmtjs/eventing/redis-streams'
import { createLogger } from '@nmtjs/core'
import { consume, EventingManager, EventStreamContract } from '@nmtjs/eventing'
import { RedisStreamsEventingAdapter } from '@nmtjs/eventing/redis-streams'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

const userCreated = EventStreamContract({
  name: 'user.created',
  topic: 'users',
  key: t.string(),
  payload: t.object({ id: t.string(), email: t.string() }),
})

class MemoryEventingAdapter implements EventingAdapter {
  published: unknown[] = []
  consumed: Array<{ options: EventingAdapterConsumeOptions }> = []

  async initialize() {}
  async dispose() {}

  async produce(record: unknown) {
    this.published.push(record)
  }

  async consume(
    options: EventingAdapterConsumeOptions,
    handler: EventingAdapterMessageHandler,
  ): Promise<EventingConsumer> {
    this.consumed.push({ options })
    await handler({
      topic: 'users',
      name: 'user.created',
      key: 'user-1',
      payload: { id: 'user-1', email: 'a@test.local' },
      headers: {},
    })
    return { closed: Promise.resolve(), async close() {} }
  }
}

describe('@nmtjs/eventing contracts', () => {
  it('publishes typed events through adapter records', async () => {
    const adapter = new MemoryEventingAdapter()
    const manager = new EventingManager({
      logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
      adapter,
    })

    await manager.produce(userCreated, {
      key: 'user-1',
      payload: { id: 'user-1', email: 'a@test.local' },
    })

    expect(adapter.published).toEqual([
      {
        topic: 'users',
        name: 'user.created',
        key: 'user-1',
        payload: { id: 'user-1', email: 'a@test.local' },
        headers: {},
      },
    ])
  })

  it('types consumer handler payloads from event definition', async () => {
    const consumer = consume(userCreated, {
      groupId: 'email-service',
      async handle(_ctx, event) {
        expectTypeOf(event.payload).toEqualTypeOf<{
          id: string
          email: string
        }>()
        expectTypeOf(event.key).toEqualTypeOf<string>()
      },
    })

    expect(consumer.groupId).toBe('email-service')
    expect(consumer.event.name).toBe('user.created')
  })

  it('consumes Redis Streams messages and acks after handler success', async () => {
    const client = new FakeRedisStreamsClient()
    const adapter = new RedisStreamsEventingAdapter({
      client: client as unknown as RedisStreamsEventingClient,
      blockMs: 1,
    })
    const controller = new AbortController()
    const messages: EventingAdapterMessage[] = []

    await adapter.initialize()
    await adapter.produce({
      topic: 'users',
      name: 'user.created',
      key: 'user-1',
      payload: { id: 'user-1', email: 'a@test.local' },
      headers: { source: 'test' },
    })

    const consumer = await adapter.consume(
      {
        topics: ['users'],
        groupId: 'email-service',
        consumerId: 'worker-1',
        from: 'earliest',
        signal: controller.signal,
      },
      async (message) => {
        messages.push(message)
        controller.abort()
      },
    )

    await consumer.closed
    await adapter.dispose()

    expect(messages).toMatchObject([
      {
        topic: 'users',
        name: 'user.created',
        key: 'user-1',
        payload: { id: 'user-1', email: 'a@test.local' },
        headers: { source: 'test' },
      },
    ])
    expect(client.groups).toEqual([{ stream: 'users', group: 'email-service' }])
    expect(client.acks).toEqual([
      { stream: 'users', group: 'email-service', id: '1-0' },
    ])
  })
})

class FakeRedisStreamsClient {
  groups: Array<{ stream: string; group: string }> = []
  acks: Array<{ stream: string; group: string; id: string }> = []
  streams = new Map<string, Array<[string, string[]]>>()
  id = 0

  async xadd(stream: string, _id: string, ...fields: string[]) {
    const id = `${++this.id}-0`
    const messages = this.streams.get(stream) ?? []
    messages.push([id, fields])
    this.streams.set(stream, messages)
    return id
  }

  async xgroup(
    action: string,
    stream: string,
    group: string,
    _id: string,
    _mkstream: string,
  ) {
    if (action !== 'CREATE') throw new Error(`Unexpected xgroup ${action}`)
    if (
      this.groups.some((item) => item.stream === stream && item.group === group)
    ) {
      throw new Error('BUSYGROUP Consumer Group name already exists')
    }
    this.groups.push({ stream, group })
  }

  async xreadgroup(...args: unknown[]) {
    const streamsIndex = args.indexOf('STREAMS')
    const streams = args.slice(
      streamsIndex + 1,
      streamsIndex + 1 + (args.length - streamsIndex - 1) / 2,
    ) as string[]

    const result = streams.flatMap((stream) => {
      const messages = this.streams.get(stream) ?? []
      this.streams.set(stream, [])
      return messages.length ? [[stream, messages] as const] : []
    })

    return result.length ? result : null
  }

  async xack(stream: string, group: string, id: string) {
    this.acks.push({ stream, group, id })
  }
}
