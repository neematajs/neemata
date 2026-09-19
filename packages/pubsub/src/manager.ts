import { Readable } from 'node:stream'

import type {
  SubscriptionParams,
  SubscriptionPublishInput,
  SubscriptionSelectedEventUnion,
  TAnySubscriptionContract,
  TAnySubscriptionEventContract,
  TSubscriptionEventContract,
} from '@nmtjs/contract'
import type { Logger } from '@nmtjs/core'
import { anyAbortSignal, isAbortError, isError } from '@nmtjs/common'
import { forkLogger } from '@nmtjs/core'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'
import { resolvePubSubChannel } from './utils.ts'

export type PubSubStream<Payload = unknown> = AsyncIterable<Payload>

export type PubSubEventParams<Event extends TAnySubscriptionEventContract> =
  Event extends TSubscriptionEventContract<any, any, infer Channel>
    ? Channel extends TAnySubscriptionContract
      ? SubscriptionParams<Channel>
      : never
    : never

export type PubSubManagerOptions = { logger: Logger; adapter: PubSubAdapter }

export class PubSubManager {
  protected readonly logger: Logger
  readonly #adapter: PubSubAdapter

  constructor(options: PubSubManagerOptions) {
    this.#adapter = options.adapter
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
  ): Promise<PubSubStream<SubscriptionSelectedEventUnion<Channel, Events>>> {
    const channelName = resolvePubSubChannel(channel, params)
    const selected = new Map<string, TAnySubscriptionEventContract>()

    for (const [event, contract] of Object.entries(channel.events)) {
      if (events && !events[event as keyof Events]) continue
      selected.set(event, contract as TAnySubscriptionEventContract)
    }

    return this.#open(channelName, selected, signal) as PubSubStream<
      SubscriptionSelectedEventUnion<Channel, Events>
    >
  }

  async publish<Event extends TAnySubscriptionEventContract>(
    event: Event,
    params: PubSubEventParams<Event>,
    payload: SubscriptionPublishInput<Event>,
  ): Promise<boolean> {
    const channel = resolvePubSubChannel(assertEventChannel(event), params)
    const encoded = event.payload.encode(payload)
    return await this.#send(channel, { event: event.event, payload: encoded })
  }

  #open(
    channel: string,
    events: Map<string, TAnySubscriptionEventContract>,
    signal?: AbortSignal,
  ): PubSubStream<unknown> {
    this.logger.trace({ channel }, 'Opening pubsub channel')

    // Owned controller lets destroy() release an adapter iterator that is
    // blocked waiting for the next message, even without a caller signal.
    const controller = new AbortController()
    const messages = this.#adapter.subscribe(
      channel,
      anyAbortSignal(signal, controller.signal),
    )

    const stream = this.#createStream(messages, events, controller)

    stream.on('close', () => {
      this.logger.trace({ channel }, 'Pubsub channel stream closed')
    })

    stream.on('error', (error) => {
      if (isAbortError(error)) return

      this.logger.error({ channel, error }, 'Pubsub channel stream failed')
    })

    this.logger.trace({ channel }, 'Created pubsub channel stream')

    return stream
  }

  async #send(channel: string, payload: unknown): Promise<boolean> {
    this.logger.trace({ channel }, 'Publishing pubsub message')

    try {
      const published = await this.#adapter.publish(channel, payload)

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

  #createStream(
    stream: AsyncIterable<PubSubMessage>,
    events: Map<string, TAnySubscriptionEventContract>,
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
            const decoded = decodeMessage(value, events, logger)
            if (!decoded) continue
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
              isError(error)
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
          logger.error(
            { error },
            'Failed to release pubsub subscription iterator',
          )
        })
        callback(error)
      },
    })
  }
}

function decodeMessage(
  message: PubSubMessage,
  events: Map<string, TAnySubscriptionEventContract>,
  logger: Logger,
) {
  const { channel, data } = message
  const { event, payload } = data
  const contract = events.get(event)

  if (!contract) {
    logger.warn({ channel, event }, 'Unknown subscription event')
    return undefined
  }

  try {
    return { event, payload: contract.payload.decode(payload) }
  } catch (error) {
    logger.error({ error }, 'Unable to decode event payload')
    return undefined
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

export type SubscribeFn = PubSubManager['subscribe']
export type PublishFn = PubSubManager['publish']
