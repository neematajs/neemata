import type {
  EventingAdapter,
  EventingAdapterConsumeOptions,
  EventingAdapterMessage,
  EventingAdapterMessageHandler,
  EventingConsumer,
} from '@nmtjs/eventing'
import type { RedisStreamsEventingClient } from '@nmtjs/eventing/redis-streams'
import { createLogger } from '@nmtjs/core'
import {
  consume,
  EventingManager,
  EventStreamContract,
  handleEventingConsumerMessage,
} from '@nmtjs/eventing'
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

  it('retries consumer handlers before failing the message', async () => {
    let attempts = 0
    const warnings: unknown[] = []
    const consumer = consume(userCreated, {
      groupId: 'email-service',
      retry: { attempts: 3 },
      async handle(_ctx, event) {
        attempts++
        expect(event.payload.email).toBe('a@test.local')
        if (attempts < 3) throw new Error('temporary failure')
      },
    })

    await handleEventingConsumerMessage(
      consumer,
      {
        logger: {
          warn(payload: unknown) {
            warnings.push(payload)
          },
        } as never,
      },
      {
        topic: 'users',
        name: 'user.created',
        key: 'user-1',
        payload: { id: 'user-1', email: 'a@test.local' },
        headers: {},
      },
    )

    expect(attempts).toBe(3)
    expect(warnings).toHaveLength(2)
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

  it('moves Redis Streams poison messages to a dead-letter stream', async () => {
    const client = new FakeRedisStreamsClient()
    const adapter = new RedisStreamsEventingAdapter({
      client: client as unknown as RedisStreamsEventingClient,
      blockMs: 1,
    })

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
        deadLetter: { topic: 'users.dead' },
      },
      async () => {
        throw new Error('poison')
      },
    )

    await waitUntil(() => client.acks.length === 1)
    await consumer.close()
    await adapter.dispose()

    expect(client.acks).toEqual([
      { stream: 'users', group: 'email-service', id: '1-0' },
    ])
    expect(client.streams.get('users.dead')).toHaveLength(1)
    expect(
      Object.fromEntries(chunkPairs(client.streams.get('users.dead')![0]![1])),
    ).toMatchObject({
      sourceTopic: 'users',
      sourceId: '1-0',
      name: 'user.created',
      key: 'user-1',
    })
  })

  it('recovers own pending Redis Streams messages before reading new messages', async () => {
    const client = new FakeRedisStreamsClient()
    const adapter = new RedisStreamsEventingAdapter({
      client: client as unknown as RedisStreamsEventingClient,
      blockMs: 1,
    })
    const controller = new AbortController()
    const messages: EventingAdapterMessage[] = []

    client.addPending('users', '42-0', [
      'name',
      'user.created',
      'payload',
      JSON.stringify({ id: 'user-1', email: 'a@test.local' }),
      'headers',
      '{}',
      'key',
      'user-1',
    ])

    await adapter.initialize()
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

    expect(messages.map((message) => message.raw)).toEqual([
      { id: '42-0', fields: expect.any(Array) },
    ])
    expect(client.acks).toEqual([
      { stream: 'users', group: 'email-service', id: '42-0' },
    ])
    expect(client.reads[0]?.ids).toEqual(['0'])
  })
})

class FakeRedisStreamsClient {
  groups: Array<{ stream: string; group: string }> = []
  acks: Array<{ stream: string; group: string; id: string }> = []
  reads: Array<{ streams: string[]; ids: string[] }> = []
  streams = new Map<string, Array<[string, string[]]>>()
  pending = new Map<string, Array<[string, string[]]>>()
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
    const ids = args.slice(streamsIndex + 1 + streams.length) as string[]
    this.reads.push({ streams, ids })
    const pendingRead = ids.every((id) => id === '0')

    const result = streams.flatMap((stream) => {
      const source = pendingRead ? this.pending : this.streams
      const messages = source.get(stream) ?? []
      if (!pendingRead) {
        source.set(stream, [])
        const pending = this.pending.get(stream) ?? []
        pending.push(...messages)
        this.pending.set(stream, pending)
      }
      return messages.length ? [[stream, messages] as const] : []
    })

    if (result.length) return result
    if (!pendingRead) await new Promise((resolve) => setTimeout(resolve, 1))
    return null
  }

  async xack(stream: string, group: string, id: string) {
    this.acks.push({ stream, group, id })
    this.pending.set(
      stream,
      (this.pending.get(stream) ?? []).filter(
        ([messageId]) => messageId !== id,
      ),
    )
  }

  addPending(stream: string, id: string, fields: string[]) {
    const messages = this.pending.get(stream) ?? []
    messages.push([id, fields])
    this.pending.set(stream, messages)
  }
}

function chunkPairs(values: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < values.length; index += 2) {
    pairs.push([values[index]!, values[index + 1] ?? ''])
  }
  return pairs
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 50; index++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for condition')
}
