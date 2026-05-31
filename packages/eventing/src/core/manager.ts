import type { Logger } from '@nmtjs/core'

import type { EventingAdapter } from './adapter.ts'
import type {
  AnyEventingEvent,
  EventingEventInput,
  EventingHeaders,
} from './event.ts'

export type ProduceFn = <E extends AnyEventingEvent>(
  event: E,
  input: EventingEventInput<E>,
) => Promise<void>

export type EventingManagerOptions = {
  logger: Logger
  adapter: EventingAdapter
}

export class EventingManager {
  protected readonly logger: Logger

  constructor(protected readonly options: EventingManagerOptions) {
    this.logger = options.logger.child({ component: EventingManager.name })
  }

  produce: ProduceFn = async (event, input) => {
    const key = event.key ? String(event.key.encode(input.key)) : input.key
    const payload = event.payload.encode(input.payload)
    const headers = normalizeHeaders(input.headers)

    this.logger.debug(`Producing eventing event [${event.name}]`)
    this.logger.trace(
      { event: event.name, topic: event.topic },
      'Eventing event',
    )

    await this.options.adapter.produce({
      topic: event.topic,
      name: event.name,
      key: key === undefined ? undefined : String(key),
      payload,
      headers,
    })

    this.logger.debug(`Produced eventing event [${event.name}]`)
    this.logger.trace(
      { event: event.name, topic: event.topic },
      'Eventing event',
    )
  }
}

function normalizeHeaders(
  headers: EventingHeaders | undefined,
): EventingHeaders {
  return headers ? { ...headers } : {}
}
