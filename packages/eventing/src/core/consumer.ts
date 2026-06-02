import type { Logger } from '@nmtjs/core'

import type {
  EventingAdapterDeadLetterOptions,
  EventingAdapterMessage,
} from './adapter.ts'
import type {
  AnyEventingEvent,
  EventingEventOutput,
  EventingHeaders,
} from './event.ts'

export type EventingConsumerContext = { logger: Logger }

export type EventingConsumerHandler<E extends AnyEventingEvent> = (
  ctx: EventingConsumerContext,
  event: EventingEventOutput<E>,
  message: EventingAdapterMessage,
) => Promise<void>

export type EventingConsumerRetryPolicy = {
  attempts?: number
  delayMs?: number
  backoff?: 'fixed' | 'exponential'
}

export type EventingConsumerDefinition<
  E extends AnyEventingEvent = AnyEventingEvent,
> = {
  event: E
  groupId: string
  consumerId?: string
  from?: 'latest' | 'earliest' | 'committed'
  /** In-process handler retry before adapter ack/commit policy runs. */
  retry?: EventingConsumerRetryPolicy
  /** Adapter may replay consumer-owned pending messages before new messages. */
  recoverPending?: boolean
  /** Adapter may move failed messages to broker-specific dead-letter storage. */
  deadLetter?: EventingAdapterDeadLetterOptions
  handle: EventingConsumerHandler<E>
}

export type AnyEventingConsumerDefinition = EventingConsumerDefinition<any>

export type EventingConsumersFactory = () =>
  | readonly AnyEventingConsumerDefinition[]
  | Promise<readonly AnyEventingConsumerDefinition[]>

export function createEventConsumer<const E extends AnyEventingEvent>(
  event: E,
  options: Omit<EventingConsumerDefinition<E>, 'event'>,
): EventingConsumerDefinition<E> {
  return Object.freeze({ event, ...options })
}

export function defineEventConsumers(
  consumers: readonly AnyEventingConsumerDefinition[],
): EventingConsumersFactory {
  return () => consumers
}

export function decodeEventingMessage<E extends AnyEventingEvent>(
  event: E,
  message: EventingAdapterMessage,
): EventingEventOutput<E> {
  return {
    name: event.name,
    topic: event.topic,
    key: event.key ? event.key.decode(message.key) : message.key,
    payload: event.payload.decode(message.payload),
    headers: normalizeHeaders(message.headers),
  } as EventingEventOutput<E>
}

export async function handleEventingConsumerMessage(
  definition: AnyEventingConsumerDefinition,
  ctx: EventingConsumerContext,
  message: EventingAdapterMessage,
) {
  const event = decodeEventingMessage(definition.event, message)
  const attempts = normalizeRetryAttempts(definition.retry?.attempts)
  const baseDelayMs = Math.max(0, definition.retry?.delayMs ?? 0)
  const backoff = definition.retry?.backoff ?? 'fixed'

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await definition.handle(ctx, event as never, message)
      return
    } catch (error) {
      if (attempt >= attempts) throw error
      const delayMs =
        backoff === 'exponential'
          ? baseDelayMs * 2 ** (attempt - 1)
          : baseDelayMs
      ctx.logger.warn(
        {
          error,
          event: definition.event.name,
          topic: definition.event.topic,
          attempt,
          attempts,
          delayMs,
        },
        'Eventing consumer handler failed; retrying',
      )
      if (delayMs > 0) await delay(delayMs)
    }
  }
}

function normalizeHeaders(
  headers: EventingHeaders | undefined,
): EventingHeaders {
  return headers ? { ...headers } : {}
}

function normalizeRetryAttempts(attempts: number | undefined): number {
  if (attempts === undefined) return 1
  return Math.max(1, Math.floor(attempts))
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
