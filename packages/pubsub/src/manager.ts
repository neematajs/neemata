import { Readable } from 'node:stream'

import type {
  SubscriptionPublishInput as PubSubPublishInput,
  SubscriptionSelectedEventUnion as PubSubSelectedEventUnion,
  SubscriptionParams,
  TAnySubscriptionContract,
  TAnySubscriptionEventContract,
  TSubscriptionEventContract,
} from '@nmtjs/contract'
import type { Logger } from '@nmtjs/core'
import { isAbortError } from '@nmtjs/common'
import { forkLogger } from '@nmtjs/core'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'
import { resolvePubSubChannel } from './utils.ts'

export type PubSubStream<Payload = unknown> = AsyncIterable<Payload>

export type SubscribeFn = <
  Channel extends TAnySubscriptionContract,
  Events extends Partial<Record<keyof Channel['events'], true>> = {},
>(
  channel: Channel,
  params: SubscriptionParams<Channel>,
  events?: Events,
  signal?: AbortSignal,
) => Promise<PubSubStream<PubSubSelectedEventUnion<Channel, Events>>>

export type PublishFn = <Event extends TAnySubscriptionEventContract>(
  event: Event,
  params: PubSubEventParams<Event>,
  payload: PubSubPublishInput<Event>,
) => Promise<boolean>

export type PubSubEventParams<Event extends TAnySubscriptionEventContract> =
  Event extends TSubscriptionEventContract<any, any, infer Channel>
    ? Channel extends TAnySubscriptionContract
      ? SubscriptionParams<Channel>
      : never
    : never

export type PubSubManagerOptions = { logger: Logger; adapter: PubSubAdapter }

export class PubSubManager {
  protected readonly logger: Logger

  constructor(protected readonly options: PubSubManagerOptions) {
    this.logger = forkLogger(options.logger, PubSubManager.name)
  }

  async subscribe<
    Channel extends TAnySubscriptionContract,
    Events extends Partial<Record<keyof Channel['events'], true>> = {},
  >(
    channel: Channel,
    params: SubscriptionParams<Channel>,
    events?: Events,
    signal?: AbortSignal,
  ): Promise<PubSubStream<PubSubSelectedEventUnion<Channel, Events>>> {
    const channelName = resolvePubSubChannel(channel, params)

    const selectedEvents = new Map<string, TAnySubscriptionEventContract>()

    if (events) {
      for (const event in events) {
        if (events[event] && event in channel.events) {
          selectedEvents.set(event, channel.events[event])
        }
      }
    } else {
      for (const event in channel.events) {
        selectedEvents.set(event, channel.events[event])
      }
    }

    return this._subscribe(channelName, selectedEvents, signal) as PubSubStream<
      PubSubSelectedEventUnion<Channel, Events>
    >
  }

  async publish<Event extends TAnySubscriptionEventContract>(
    event: Event,
    params: PubSubEventParams<Event>,
    payload: PubSubPublishInput<Event>,
  ): Promise<boolean> {
    const channel = resolvePubSubChannel(assertEventChannel(event), params)
    const encodedPayload = event.payload.encode(payload)
    return await this._publish(channel, {
      event: event.event,
      payload: encodedPayload,
    })
  }

  protected _subscribe(
    channel: string,
    events: Map<string, TAnySubscriptionEventContract>,
    signal?: AbortSignal,
  ): PubSubStream<unknown> {
    this.logger.trace({ channel }, 'Opening pubsub channel')

    const { adapter } = this.options

    const stream = this.createMessageStream(
      adapter.subscribe(channel, signal),
      events,
    )

    stream.on('close', () => {
      this.logger.trace({ channel }, 'Pubsub channel stream closed')
    })

    stream.on('error', (error) => {
      this.logger.error({ channel, error }, 'Pubsub channel stream failed')
    })

    this.logger.trace({ channel }, 'Created pubsub channel stream')

    return stream
  }

  protected _publish = async (
    channel: string,
    payload: unknown,
  ): Promise<boolean> => {
    const adapter = this.options.adapter

    this.logger.trace({ channel }, 'Publishing pubsub message')

    try {
      const published = await adapter.publish(channel, payload)

      if (published) {
        this.logger.trace({ channel }, 'Published pubsub message')
      } else {
        this.logger.warn({ channel }, 'Pubsub adapter reported publish failure')
      }

      return published
    } catch (error) {
      this.logger.error({ channel, error }, 'Failed to publish pubsub message')
      throw error
    }
  }

  private createMessageStream(
    stream: AsyncIterable<PubSubMessage>,
    events: Map<string, TAnySubscriptionEventContract>,
  ): Readable {
    const logger = this.logger
    return new Readable({
      objectMode: true,
      async read() {
        try {
          for await (const { channel, data } of stream) {
            const { event, payload } = data
            const contract = events.get(event)
            if (!contract) {
              logger.warn({ channel, event }, 'Unknown subscription event')
              continue
            }
            try {
              this.push({ event, payload: contract.payload.decode(payload) })
            } catch (error) {
              logger.error({ error }, 'Unable to decode event payload')
            }
          }
          this.push(null)
        } catch (error) {
          if (isAbortError(error)) {
            this.push(null)
          } else {
            this.destroy(
              Error.isError(error)
                ? error
                : new Error('Unknown subscription error', { cause: error }),
            )
          }
        }
      },
    })
  }
}

function assertEventChannel(
  event: TAnySubscriptionEventContract,
): TAnySubscriptionContract {
  if (!event.subscription) {
    throw new Error(`PubSub event [${event.event}] is not bound to a channel`)
  }
  return event.subscription
}
