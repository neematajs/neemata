import type { Logger } from '@nmtjs/core'
import { forkLogger } from '@nmtjs/core'

import type { EventingAdapter } from './adapter.ts'
import type {
  AnyEventingEvent,
  EventingEventChannel,
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
    this.logger = forkLogger(options.logger, EventingManager.name)
  }

  produce: ProduceFn = async (event, input) => {
    const channel = event.subscription as EventingEventChannel<typeof event>
    const key = channel.key?.(channel.params.decode(input.params as never))
    const payload = event.payload.encode(input.payload)
    const headers = normalizeHeaders(input.headers)

    this.logger.debug(`Producing eventing event [${event.event}]`)
    this.logger.trace(
      { event: event.event, topic: channel.namespace },
      'Eventing event',
    )

    await this.options.adapter.produce({
      topic: channel.namespace,
      name: event.event,
      key: key === undefined ? undefined : String(key),
      payload,
      headers,
    })

    this.logger.debug(`Produced eventing event [${event.event}]`)
    this.logger.trace(
      { event: event.event, topic: channel.namespace },
      'Eventing event',
    )
  }
}

function normalizeHeaders(
  headers: EventingHeaders | undefined,
): EventingHeaders {
  return headers ? { ...headers } : {}
}
