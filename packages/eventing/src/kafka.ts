import type { Logger } from '@nmtjs/core'
import type { ConsumerOptions, ProducerOptions } from '@platformatic/kafka'
import { forkLogger } from '@nmtjs/core'
import {
  Consumer,
  Producer,
  stringDeserializers,
  stringSerializers,
} from '@platformatic/kafka'

import type {
  EventingAdapter,
  EventingAdapterConsumeOptions,
  EventingAdapterMessage,
  EventingAdapterMessageHandler,
  EventingAdapterProduceRecord,
  EventingConsumer,
} from './core/adapter.ts'

export type KafkaEventingAdapterOptions = {
  clientId: string
  bootstrapBrokers: readonly string[]
  producer?: Partial<ProducerOptions<string, string, string, string>>
  /**
   * Kafka consumer options.
   *
   * Concurrency is controlled by broker partitions and consumer groups, not by
   * this adapter. Multiple Neem eventing runtime threads using the same
   * `groupId` share partitions. Extra consumers beyond partition count can sit
   * idle. Ordering is only guaranteed within one partition.
   */
  consumer?: Partial<
    Omit<ConsumerOptions<string, string, string, string>, 'groupId'>
  >
  logger?: Logger
}

export class KafkaEventingAdapter implements EventingAdapter {
  protected producer?: Producer<string, string, string, string>
  protected readonly consumers = new Set<
    Consumer<string, string, string, string>
  >()
  protected readonly logger?: Logger

  constructor(protected readonly options: KafkaEventingAdapterOptions) {
    this.logger = options.logger
      ? forkLogger(options.logger, KafkaEventingAdapter.name)
      : undefined
  }

  async initialize() {
    this.producer = new Producer({
      clientId: this.options.clientId,
      bootstrapBrokers: [...this.options.bootstrapBrokers],
      serializers: stringSerializers,
      ...this.options.producer,
    })
    this.logger?.debug('Kafka eventing adapter initialized')
  }

  async dispose() {
    await Promise.allSettled(
      [...this.consumers].map((consumer) => consumer.close(true)),
    )
    this.consumers.clear()
    await this.producer?.close(true)
    this.producer = undefined
    this.logger?.debug('Kafka eventing adapter disposed')
  }

  async produce(record: EventingAdapterProduceRecord) {
    if (!this.producer) throw new Error('KafkaEventingAdapter not initialized')

    await this.producer.send({
      messages: [
        {
          topic: record.topic,
          key: record.key,
          value: JSON.stringify({ name: record.name, payload: record.payload }),
          headers: record.headers,
        },
      ],
    })
  }

  async consume(
    options: EventingAdapterConsumeOptions,
    handler: EventingAdapterMessageHandler,
  ): Promise<EventingConsumer> {
    if (options.deadLetter && !this.producer) {
      throw new Error('KafkaEventingAdapter not initialized')
    }

    const consumer = new Consumer({
      clientId: options.consumerId ?? this.options.clientId,
      bootstrapBrokers: [...this.options.bootstrapBrokers],
      groupId: options.groupId,
      deserializers: stringDeserializers,
      ...this.options.consumer,
    })
    this.consumers.add(consumer)

    const stream = await consumer.consume({
      topics: [...options.topics],
      mode: options.from ?? 'committed',
      fallbackMode: options.from === 'earliest' ? 'earliest' : 'latest',
      autocommit: false,
    })

    const closed = (async () => {
      try {
        for await (const message of stream) {
          options.signal?.throwIfAborted()
          const event = decodeKafkaMessage(message)
          try {
            await handler(event)
            await message.commit()
          } catch (error) {
            if (!options.deadLetter) throw error

            await this.producer!.send({
              messages: [
                {
                  topic:
                    options.deadLetter.topic ?? getDeadLetterTopic(event.topic),
                  key: message.key,
                  value: message.value,
                  headers: {
                    ...event.headers,
                    'x-eventing-source-topic': event.topic,
                    'x-eventing-error': getErrorMessage(error),
                  },
                },
              ],
            })
            await message.commit()
            this.logger?.error(
              {
                error,
                topic: event.topic,
                deadLetterTopic:
                  options.deadLetter.topic ?? getDeadLetterTopic(event.topic),
              },
              'Kafka event moved to dead-letter topic',
            )
          }
        }
      } finally {
        await closeKafkaStream(stream)
        await closeKafkaConsumer(consumer)
        this.consumers.delete(consumer)
      }
    })()

    return {
      closed,
      close: async () => {
        await closeKafkaStream(stream)
        await closeKafkaConsumer(consumer)
        await closed.catch(() => undefined)
      },
    }
  }
}

function getDeadLetterTopic(topic: string): string {
  return `${topic}.dlq`
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function closeKafkaStream(stream: { close(): Promise<void> | void }) {
  await Promise.resolve(stream.close()).catch(() => undefined)
}

async function closeKafkaConsumer(consumer: {
  close(force?: boolean): Promise<void> | void
}) {
  await Promise.resolve(consumer.close(true)).catch(() => undefined)
}

function decodeKafkaMessage(message: {
  topic: string
  key?: string
  value?: string
  headers: Map<string, string>
}): EventingAdapterMessage {
  const value = message.value ? JSON.parse(message.value) : {}
  return {
    topic: message.topic,
    name: String(value.name),
    key: message.key,
    payload: value.payload,
    headers: Object.fromEntries(message.headers.entries()),
    raw: message,
  }
}
