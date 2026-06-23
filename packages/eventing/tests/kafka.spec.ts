import { afterEach, describe, expect, it, vi } from 'vitest'

describe('KafkaEventingAdapter', () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('dead-letters failed messages before committing the original offset', async () => {
    const produced: unknown[] = []
    const message = {
      topic: 'orders',
      key: 'order-1',
      value: JSON.stringify({
        name: 'orderCreated',
        payload: { id: 'order-1' },
      }),
      headers: new Map([['source', 'unit']]),
      commit: vi.fn(async () => {}),
    }
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield message
      },
      close: vi.fn(async () => {}),
    }

    vi.doMock('@platformatic/kafka', () => ({
      Producer: class {
        async send(record: unknown) {
          produced.push(record)
        }

        async close() {}
      },
      Consumer: class {
        async consume() {
          return stream
        }

        async close() {}
      },
      stringDeserializers: {},
      stringSerializers: {},
    }))

    const { KafkaEventingAdapter } = await import('../src/kafka.ts')
    const adapter = new KafkaEventingAdapter({
      clientId: 'client',
      bootstrapBrokers: ['localhost:9092'],
    })
    await adapter.initialize()

    const consumer = await adapter.consume(
      { topics: ['orders'], groupId: 'orders-service', deadLetter: {} },
      async () => {
        throw new Error('poison')
      },
    )

    await expect(consumer.closed).resolves.toBeUndefined()
    expect(produced).toEqual([
      {
        messages: [
          {
            topic: 'orders.dlq',
            key: 'order-1',
            value: JSON.stringify({
              name: 'orderCreated',
              payload: { id: 'order-1' },
            }),
            headers: {
              source: 'unit',
              'x-eventing-source-topic': 'orders',
              'x-eventing-error': 'poison',
            },
          },
        ],
      },
    ])
    expect(message.commit).toHaveBeenCalledOnce()
  })
})
