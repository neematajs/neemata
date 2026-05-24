import type { Logger } from '@nmtjs/core'
import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'

import type {
  EventingAdapter,
  EventingAdapterConsumeOptions,
  EventingAdapterMessage,
  EventingAdapterMessageHandler,
  EventingAdapterProduceRecord,
  EventingConsumer,
} from './core/adapter.ts'

export type RedisStreamsEventingClient = Redis | Valkey

export type RedisStreamsEventingAdapterOptions = {
  client: RedisStreamsEventingClient
  logger?: Logger
  blockMs?: number
  count?: number
}

export class RedisStreamsEventingAdapter implements EventingAdapter {
  protected readonly logger?: Logger

  constructor(protected readonly options: RedisStreamsEventingAdapterOptions) {
    this.logger = options.logger?.child({
      component: RedisStreamsEventingAdapter.name,
    })
  }

  async initialize() {
    this.logger?.debug('Redis Streams eventing adapter initialized')
  }

  async dispose() {
    this.logger?.debug('Redis Streams eventing adapter disposed')
  }

  async produce(record: EventingAdapterProduceRecord) {
    await this.options.client.xadd(
      record.topic,
      '*',
      'name',
      record.name,
      'payload',
      JSON.stringify(record.payload),
      'headers',
      JSON.stringify(record.headers ?? {}),
      'key',
      record.key ?? '',
    )
  }

  async consume(
    options: EventingAdapterConsumeOptions,
    handler: EventingAdapterMessageHandler,
  ): Promise<EventingConsumer> {
    const controller = new AbortController()
    const signal = mergeSignals(controller.signal, options.signal)
    const consumerId = options.consumerId ?? `${options.groupId}-${process.pid}`

    for (const topic of options.topics) {
      await ensureRedisStreamGroup(
        this.options.client,
        topic,
        options.groupId,
        options.from === 'earliest' ? '0' : '$',
      )
    }

    const closed = (async () => {
      while (!signal.aborted) {
        const response = await this.options.client.xreadgroup(
          'GROUP',
          options.groupId,
          consumerId,
          'COUNT',
          this.options.count ?? 10,
          'BLOCK',
          this.options.blockMs ?? 500,
          'STREAMS',
          ...options.topics,
          ...options.topics.map(() => '>'),
        )

        if (!response) continue

        for (const [topic, messages] of response as RedisStreamReadResponse) {
          for (const [id, fields] of messages) {
            signal.throwIfAborted()
            const message = decodeRedisStreamMessage(topic, id, fields)
            await handler(message)
            await this.options.client.xack(topic, options.groupId, id)
          }
        }
      }
    })()

    return {
      closed,
      close: async () => {
        controller.abort()
        await closed.catch(() => undefined)
      },
    }
  }
}

type RedisStreamReadResponse = Array<
  [stream: string, messages: Array<[id: string, fields: string[]]>]
>

async function ensureRedisStreamGroup(
  client: RedisStreamsEventingClient,
  stream: string,
  group: string,
  id: string,
) {
  try {
    await client.xgroup('CREATE', stream, group, id, 'MKSTREAM')
  } catch (error) {
    if (!isBusyGroupError(error)) throw error
  }
}

function isBusyGroupError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('BUSYGROUP')
}

function decodeRedisStreamMessage(
  topic: string,
  id: string,
  fields: string[],
): EventingAdapterMessage {
  const record = Object.fromEntries(chunkPairs(fields))
  return {
    topic,
    name: record.name ?? '',
    key: record.key || undefined,
    payload: record.payload ? JSON.parse(record.payload) : undefined,
    headers: record.headers ? JSON.parse(record.headers) : {},
    raw: { id, fields },
  }
}

function chunkPairs(values: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let index = 0; index < values.length; index += 2) {
    pairs.push([values[index]!, values[index + 1] ?? ''])
  }
  return pairs
}

function mergeSignals(
  ownSignal: AbortSignal,
  externalSignal: AbortSignal | undefined,
): AbortSignal {
  if (!externalSignal) return ownSignal
  const controller = new AbortController()
  const abort = () => controller.abort()
  ownSignal.addEventListener('abort', abort, { once: true })
  externalSignal.addEventListener('abort', abort, { once: true })
  return controller.signal
}
