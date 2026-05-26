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
    const recoverPending = options.recoverPending ?? true

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
        const response =
          (recoverPending &&
            (await readRedisStreams(this.options.client, {
              groupId: options.groupId,
              consumerId,
              topics: options.topics,
              count: this.options.count ?? 10,
              ids: options.topics.map(() => '0'),
            }))) ||
          (await readRedisStreams(this.options.client, {
            groupId: options.groupId,
            consumerId,
            topics: options.topics,
            count: this.options.count ?? 10,
            blockMs: this.options.blockMs ?? 500,
            ids: options.topics.map(() => '>'),
          }))

        if (!response) continue

        for (const [topic, messages] of response as RedisStreamReadResponse) {
          for (const [id, fields] of messages) {
            signal.throwIfAborted()
            try {
              const message = decodeRedisStreamMessage(topic, id, fields)
              await handler(message)
              await this.options.client.xack(topic, options.groupId, id)
            } catch (error) {
              if (signal.aborted) throw error
              if (!options.deadLetter) throw error

              await writeRedisDeadLetter(this.options.client, {
                sourceTopic: topic,
                sourceId: id,
                fields,
                deadLetterTopic:
                  options.deadLetter.topic ?? getDeadLetterTopic(topic),
                error,
              })
              await this.options.client.xack(topic, options.groupId, id)
              this.logger?.error(
                {
                  error,
                  topic,
                  id,
                  deadLetterTopic:
                    options.deadLetter.topic ?? getDeadLetterTopic(topic),
                },
                'Redis Streams event moved to dead-letter stream',
              )
            }
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

type RedisStreamsReadOptions = {
  groupId: string
  consumerId: string
  topics: readonly string[]
  count: number
  blockMs?: number
  ids: readonly string[]
}

async function readRedisStreams(
  client: RedisStreamsEventingClient,
  options: RedisStreamsReadOptions,
) {
  const blockArgs =
    options.blockMs === undefined ? [] : ['BLOCK', options.blockMs]
  const xreadgroup = client.xreadgroup.bind(client) as (
    ...args: unknown[]
  ) => Promise<unknown>
  const response = await xreadgroup(
    'GROUP',
    options.groupId,
    options.consumerId,
    'COUNT',
    options.count,
    ...blockArgs,
    'STREAMS',
    ...options.topics,
    ...options.ids,
  )
  return hasRedisStreamMessages(response) ? response : null
}

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

function hasRedisStreamMessages(response: unknown): boolean {
  return (
    Array.isArray(response) &&
    response.some(
      (entry) =>
        Array.isArray(entry) && Array.isArray(entry[1]) && entry[1].length > 0,
    )
  )
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

async function writeRedisDeadLetter(
  client: RedisStreamsEventingClient,
  input: {
    sourceTopic: string
    sourceId: string
    fields: string[]
    deadLetterTopic: string
    error: unknown
  },
) {
  const record = Object.fromEntries(chunkPairs(input.fields))
  const headers = parseHeaders(record.headers)
  await client.xadd(
    input.deadLetterTopic,
    '*',
    'sourceTopic',
    input.sourceTopic,
    'sourceId',
    input.sourceId,
    'name',
    record.name ?? '',
    'payload',
    record.payload ?? '',
    'headers',
    JSON.stringify({
      ...headers,
      'x-eventing-source-topic': input.sourceTopic,
      'x-eventing-source-id': input.sourceId,
      'x-eventing-error': getErrorMessage(input.error),
    }),
    'key',
    record.key ?? '',
  )
}

function getDeadLetterTopic(topic: string): string {
  return `${topic}.dlq`
}

function parseHeaders(headers: string | undefined): Record<string, string> {
  if (!headers) return {}
  try {
    return JSON.parse(headers)
  } catch {
    return {}
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
