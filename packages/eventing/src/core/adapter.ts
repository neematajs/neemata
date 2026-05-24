import type { EventingHeaders } from './event.ts'

export type EventingAdapterProduceRecord = {
  topic: string
  name: string
  key?: string
  payload: unknown
  headers?: EventingHeaders
}

export type EventingAdapterMessage = {
  topic: string
  name: string
  key?: string
  payload: unknown
  headers: EventingHeaders
  raw?: unknown
}

export type EventingConsumeFrom = 'latest' | 'earliest' | 'committed'

export type EventingAdapterConsumeOptions = {
  topics: readonly string[]
  groupId: string
  consumerId?: string
  from?: EventingConsumeFrom
  signal?: AbortSignal
}

export type EventingAdapterMessageHandler = (
  message: EventingAdapterMessage,
) => Promise<void>

export type EventingConsumer = { close(): Promise<void>; closed: Promise<void> }

export interface EventingAdapter {
  initialize(): Promise<void>
  dispose(): Promise<void>
  produce(record: EventingAdapterProduceRecord): Promise<void>
  consume(
    options: EventingAdapterConsumeOptions,
    handler: EventingAdapterMessageHandler,
  ): Promise<EventingConsumer>
}
