import type { Logger } from '@nmtjs/core'

import type { EventingAdapterMessage } from './adapter.ts'
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

export type EventingConsumerDefinition<
  E extends AnyEventingEvent = AnyEventingEvent,
> = {
  event: E
  groupId: string
  consumerId?: string
  from?: 'latest' | 'earliest' | 'committed'
  handle: EventingConsumerHandler<E>
}

export type AnyEventingConsumerDefinition = EventingConsumerDefinition<any>

export type EventingConsumersFactory = () =>
  | readonly AnyEventingConsumerDefinition[]
  | Promise<readonly AnyEventingConsumerDefinition[]>

export function consume<const E extends AnyEventingEvent>(
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

function normalizeHeaders(
  headers: EventingHeaders | undefined,
): EventingHeaders {
  return headers ? { ...headers } : {}
}
