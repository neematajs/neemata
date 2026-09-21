import { Readable } from 'node:stream'

import { decodeWith, encodeWith } from '@nmtjs/common'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'
import type {
  Channel,
  ChannelEvent,
  EventParams,
  EventPayload,
  SelectedEventUnion,
} from './contract.ts'
import type { PubSubLogger } from './utils.ts'
import { isAbortError, resolvePubSubChannel } from './utils.ts'

export type PubSubStream<Payload = unknown> = AsyncIterable<Payload>

export type SubscribeFn = <
  C extends Channel,
  Events extends Partial<Record<keyof C['events'], true>> = {},
>(
  channel: C,
  params: ChannelParamsOf<C>,
  events?: Events,
  signal?: AbortSignal,
) => Promise<PubSubStream<SelectedEventUnion<C, Events>>>

export type PublishFn = <Event extends ChannelEvent>(
  event: Event,
  params: EventParams<Event>,
  payload: EventPayload<Event>,
) => Promise<boolean>

export type ChannelParamsOf<C extends Channel> =
  C extends Channel<infer Params, any> ? Params : never

export type PubSubManagerOptions = {
  adapter: PubSubAdapter
  logger?: PubSubLogger
}

export class PubSubManager {
  protected readonly logger?: PubSubLogger

  constructor(protected readonly options: PubSubManagerOptions) {
    this.logger = options.logger
  }

  async subscribe<
    C extends Channel,
    Events extends Partial<Record<keyof C['events'], true>> = {},
  >(
    channel: C,
    params: ChannelParamsOf<C>,
    events?: Events,
    signal?: AbortSignal,
  ): Promise<PubSubStream<SelectedEventUnion<C, Events>>> {
    const channelName = resolvePubSubChannel(channel, params)

    const selectedEvents = new Map<string, ChannelEvent>()

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
      SelectedEventUnion<C, Events>
    >
  }

  async publish<Event extends ChannelEvent>(
    event: Event,
    params: EventParams<Event>,
    payload: EventPayload<Event>,
  ): Promise<boolean> {
    const channel = resolvePubSubChannel(event.channel, params)
    const encodedPayload = encodeWith(event.payload, payload)
    return await this._publish(channel, {
      event: event.event,
      payload: encodedPayload,
    })
  }

  protected _subscribe(
    channel: string,
    events: Map<string, ChannelEvent>,
    signal?: AbortSignal,
  ): PubSubStream<unknown> {
    this.logger?.trace({ channel }, 'Opening pubsub channel')

    const { adapter } = this.options

    // Owned controller lets destroy() release an adapter iterator that is
    // blocked waiting for the next message, even without a caller signal.
    const controller = new AbortController()
    const finalSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal

    const stream = this.createMessageStream(
      adapter.subscribe(channel, finalSignal),
      events,
      controller,
    )

    stream.on('close', () => {
      this.logger?.trace({ channel }, 'Pubsub channel stream closed')
    })

    stream.on('error', (error) => {
      if (isAbortError(error)) return

      this.logger?.error({ channel, error }, 'Pubsub channel stream failed')
    })

    this.logger?.trace({ channel }, 'Created pubsub channel stream')

    return stream
  }

  protected _publish = async (
    channel: string,
    payload: unknown,
  ): Promise<boolean> => {
    const adapter = this.options.adapter

    this.logger?.trace({ channel }, 'Publishing pubsub message')

    try {
      const published = await adapter.publish(channel, payload)

      if (published) {
        this.logger?.trace({ channel }, 'Published pubsub message')
      } else {
        this.logger?.warn(
          { channel },
          'Pubsub adapter reported publish failure',
        )
      }

      return published
    } catch (error) {
      this.logger?.error({ channel, error }, 'Failed to publish pubsub message')
      throw error
    }
  }

  private createMessageStream(
    stream: AsyncIterable<PubSubMessage>,
    events: Map<string, ChannelEvent>,
    controller: AbortController,
  ): Readable {
    const logger = this.logger
    const iterator = stream[Symbol.asyncIterator]()
    // Node clears `reading` on every push and may re-invoke `read` while the
    // previous pump is still awaiting; a second concurrent pump would race
    // over the shared iterator and double-push null at end of stream.
    let pumping = false
    return new Readable({
      objectMode: true,
      async read() {
        if (pumping) return
        pumping = true
        try {
          while (!this.destroyed) {
            const { done, value } = await iterator.next()
            if (done) break
            if (this.destroyed) break
            const { channel, data } = value
            const { event, payload } = data
            const contract = events.get(event)
            if (!contract) {
              logger?.warn({ channel, event }, 'Unknown subscription event')
              continue
            }
            let decoded: unknown
            try {
              decoded = {
                event,
                payload: decodeWith(contract.payload, payload),
              }
            } catch (error) {
              logger?.error({ error }, 'Unable to decode event payload')
              continue
            }
            if (!this.push(decoded)) {
              // Backpressure: pause until the consumer drains and Node
              // invokes `read` again.
              pumping = false
              return
            }
          }
          if (!this.destroyed) this.push(null)
        } catch (error) {
          if (isAbortError(error)) {
            if (!this.destroyed) this.push(null)
          } else {
            this.destroy(
              Error.isError(error)
                ? error
                : new Error('Unknown subscription error', { cause: error }),
            )
          }
        }
      },
      destroy(error, callback) {
        // Abort first: return() alone queues behind a next() that is blocked
        // waiting for the next message and would never let cleanup run.
        controller.abort()
        // Best-effort release of the adapter subscription; don't block
        // destruction on the iterator settling.
        iterator.return?.()?.catch((error) => {
          logger?.error(
            { error },
            'Failed to release pubsub subscription iterator',
          )
        })
        callback(error)
      },
    })
  }
}
