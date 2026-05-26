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

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'
import { resolvePubSubChannelName } from './utils.ts'

export type PubSubChannelStream = { channel: string; stream: Readable }

export type PubSubStream<Payload = unknown> = Omit<
  Readable,
  typeof Symbol.asyncIterator
> & { [Symbol.asyncIterator]: () => AsyncIterator<Payload> }

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
    ? SubscriptionParams<Channel>
    : never

export type PubSubManagerOptions = { logger: Logger; adapter: PubSubAdapter }

export class PubSubManager {
  readonly channels = new Map<string, PubSubChannelStream>()
  protected readonly logger: Logger

  constructor(protected readonly options: PubSubManagerOptions) {
    this.logger = options.logger.child({ component: PubSubManager.name })
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
    const channelName = resolvePubSubChannelName(channel, params)
    const selected = events ?? {}
    const selectedEvents =
      Object.keys(selected).length === 0
        ? Object.values(channel.events)
        : Object.entries(selected).flatMap(([key, include]) =>
            include ? [channel.events[key]!] : [],
          )
    const eventByName = new Map(
      selectedEvents.map((event) => [event.name, event]),
    )

    const stream = await this.subscribeRaw<PubSubMessage>(channelName, signal)
    return this.createDecodedEventStream(stream, eventByName) as PubSubStream<
      PubSubSelectedEventUnion<Channel, Events>
    >
  }

  async publish<Event extends TAnySubscriptionEventContract>(
    event: Event,
    params: PubSubEventParams<Event>,
    payload: PubSubPublishInput<Event>,
  ): Promise<boolean> {
    const channelName = resolvePubSubChannelName(
      assertEventChannel(event),
      params,
    )
    const encodedPayload = event.payload.encode(payload)
    return await this.publishRaw(channelName, {
      event: event.name,
      data: encodedPayload,
    })
  }

  subscribeRaw = async <Payload = unknown>(
    channel: string,
    signal?: AbortSignal,
  ): Promise<PubSubStream<Payload>> => {
    if (this.channels.has(channel)) {
      this.logger.trace(
        { channel, activeChannels: this.channels.size },
        'Reusing pubsub channel stream',
      )
      return this.channels.get(channel)!.stream as PubSubStream<Payload>
    }

    this.logger.debug({ channel }, 'Opening pubsub channel')

    const adapter = this.options.adapter
    const stream = this.createMessageStream(adapter.subscribe(channel, signal))

    stream.on('close', () => {
      this.channels.delete(channel)
      this.logger.debug(
        { channel, activeChannels: this.channels.size },
        'Pubsub channel stream closed',
      )
    })
    stream.on('error', (error) => {
      this.logger.warn({ channel, error }, 'Pubsub channel stream failed')
    })

    this.channels.set(channel, { channel, stream })
    this.logger.debug(
      { channel, activeChannels: this.channels.size },
      'Created pubsub channel stream',
    )

    return stream as PubSubStream<Payload>
  }

  publishRaw = async (channel: string, payload: unknown): Promise<boolean> => {
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
    iterable: AsyncGenerator<PubSubMessage>,
  ): Readable {
    const logger = this.logger

    return new Readable({
      objectMode: true,
      read() {
        iterable.next().then(
          ({ value, done }) => {
            if (done) {
              logger.trace('Pubsub adapter stream ended')
              this.push(null)
              return
            }

            logger.trace({ channel: value.channel }, 'Received pubsub message')
            this.push(value)
          },
          (error) => {
            if (isAbortError(error)) {
              logger.trace('Pubsub adapter stream aborted')
              this.push(null)
            } else {
              logger.warn({ error }, 'Pubsub adapter stream failed')
              this.destroy(error)
            }
          },
        )
      },
    })
  }

  private createDecodedEventStream(
    source: PubSubStream<PubSubMessage>,
    events: Map<string, TAnySubscriptionEventContract>,
  ): PubSubStream {
    const logger = this.logger

    return new Readable({
      objectMode: true,
      read() {
        void (async () => {
          while (true) {
            const { value, done } = await source[Symbol.asyncIterator]().next()
            if (done) {
              this.push(null)
              return
            }

            const payload = value.payload as { event?: string; data?: unknown }
            const event = payload.event ? events.get(payload.event) : undefined
            if (!event) {
              logger.trace(
                { channel: value.channel, event: payload.event },
                'Dropped pubsub event for inactive subscription',
              )
              continue
            }

            try {
              this.push({
                event: event.name,
                data: event.payload.decode(payload.data),
              })
              return
            } catch (error) {
              logger.warn(
                { channel: value.channel, event: event.name, error },
                'Failed to decode pubsub event payload',
              )
              this.destroy(error as Error)
              return
            }
          }
        })().catch((error) => this.destroy(error))
      },
    }) as PubSubStream
  }
}

function assertEventChannel(
  event: TAnySubscriptionEventContract,
): TAnySubscriptionContract {
  if (!event.subscription) {
    throw new Error(`PubSub event [${event.name}] is not bound to a channel`)
  }
  return event.subscription
}
