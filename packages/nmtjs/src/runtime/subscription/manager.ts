import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'

import type {
  SubcriptionOptions,
  TAnyEventContract,
  TAnySubscriptionContract,
} from '@nmtjs/contract'
import type { Container, Logger } from '@nmtjs/core'
import type { t } from '@nmtjs/type'
import { isAbortError } from '@nmtjs/common'

import { subscriptionAdapter } from '../injectables.ts'

export type SubscriptionAdapterEvent = { channel: string; payload: any }

export interface SubscriptionAdapterType {
  publish(channel: string, payload: any): Promise<boolean>
  subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SubscriptionAdapterEvent>
  initialize(): Promise<void>
  dispose(): Promise<void>
}

export type SubscriptionChannel = {
  stream: Readable
  subscription: TAnySubscriptionContract
  event: TAnyEventContract
}

export type SubscribeFn = <
  Contract extends TAnySubscriptionContract,
  Events extends {
    [K in keyof Contract['events']]?: true
  },
>(
  subscription: Contract,
  events: Events,
  options: Contract['options'],
  signal?: AbortSignal,
) => Promise<
  Omit<Readable, typeof Symbol.asyncIterator> & {
    [Symbol.asyncIterator]: () => AsyncIterator<
      {} extends Events
        ? {
            [K in keyof Contract['events']]: {
              event: K
              data: t.infer.decode.output<Contract['events'][K]['payload']>
            }
          }[keyof Contract['events']]
        : {
            [K in keyof Events]: K extends keyof Contract['events']
              ? {
                  event: K
                  data: t.infer.decode.output<Contract['events'][K]['payload']>
                }
              : never
          }[keyof Events]
    >
  }
>

export type PublishFn = <
  S extends TAnySubscriptionContract,
  E extends S['events'][keyof S['events']],
>(
  event: E,
  options: S['options'],
  data: t.infer.decode.input<E['payload']>,
) => Promise<boolean>

export type SubscriptionManagerOptions = {
  logger: Logger
  container: Container
}

export class SubscriptionManager {
  readonly subscriptions = new Map<string, SubscriptionChannel>()
  protected readonly logger: Logger

  constructor(protected readonly options: SubscriptionManagerOptions) {
    this.logger = options.logger.child({ component: SubscriptionManager.name })
  }

  protected get adapter() {
    return this.options.container.resolve(subscriptionAdapter)
  }

  subscribe: SubscribeFn = async (subscription, events, options, signal) => {
    const adapter = await this.adapter

    const eventKeys =
      Object.keys(events).length === 0
        ? Object.keys(subscription.events)
        : Object.keys(events)

    this.logger.debug(
      { subscription: subscription.name, eventCount: eventKeys.length },
      'Opening subscription',
    )

    const streams = Array(eventKeys.length)

    for (const index in eventKeys) {
      const event = subscription.events[eventKeys[index]]
      const channel = getChannelName(event, options)
      if (this.subscriptions.has(channel)) {
        streams[index] = this.subscriptions.get(channel)!.stream
        this.logger.trace(
          {
            channel,
            event: event.name,
            activeChannels: this.subscriptions.size,
          },
          'Reusing pubsub channel stream',
        )
      } else {
        const iterable = adapter.subscribe(channel, signal)
        const stream = this.createEventStream(iterable)
        stream.on('close', () => {
          this.subscriptions.delete(channel)
          this.logger.debug(
            {
              channel,
              event: event.name,
              activeChannels: this.subscriptions.size,
            },
            'Pubsub channel stream closed',
          )
        })
        stream.on('error', (error) => {
          this.logger.warn(
            { channel, event: event.name, error },
            'Pubsub channel stream failed',
          )
        })
        streams[index] = stream
        this.subscriptions.set(channel, { subscription, event, stream })
        this.logger.debug(
          {
            channel,
            event: event.name,
            activeChannels: this.subscriptions.size,
          },
          'Creating channel stream',
        )
      }
    }

    const mergedStream = mergeEventStreams(streams, signal)

    mergedStream.once('close', () => {
      this.logger.debug(
        { subscription: subscription.name, eventCount: eventKeys.length },
        'Pubsub subscription stream closed',
      )
    })
    mergedStream.once('error', (error) => {
      this.logger.warn(
        {
          subscription: subscription.name,
          eventCount: eventKeys.length,
          error,
        },
        'Pubsub subscription stream failed',
      )
    })

    return mergedStream
  }

  publish: PublishFn = async (event, options, data) => {
    const adapter = await this.adapter

    const channel = getChannelName(event, options)

    this.logger.trace({ channel, event: event.name }, 'Publishing pubsub event')

    try {
      const payload = event.payload.encode(data)
      const published = await adapter.publish(channel, payload)

      if (published) {
        this.logger.trace(
          { channel, event: event.name },
          'Published pubsub event',
        )
      } else {
        this.logger.warn(
          { channel, event: event.name },
          'Pubsub adapter reported publish failure',
        )
      }

      return published
    } catch (error: any) {
      this.logger.error(
        { channel, event: event.name, error },
        'Failed to publish pubsub event',
      )
      throw error
    }
  }

  private createEventStream(
    iterable: AsyncGenerator<SubscriptionAdapterEvent>,
  ): Readable {
    const { subscriptions } = this
    const logger = this.logger

    return new Readable({
      objectMode: true,
      read() {
        iterable.next().then(
          ({ value, done }) => {
            if (done) {
              logger.trace('Pubsub adapter stream ended')
              this.push(null)
            } else {
              const subscription = subscriptions.get(value.channel)
              if (subscription) {
                const { event } = subscription
                try {
                  const data = event.payload.decode(value.payload)
                  logger.trace(
                    { channel: value.channel, event: event.name },
                    'Received event',
                  )
                  this.push({ event: event.name, data })
                } catch (error: any) {
                  logger.warn(
                    { channel: value.channel, event: event.name, error },
                    'Failed to decode pubsub event payload',
                  )
                  this.destroy(error)
                }
              } else {
                logger.trace(
                  { channel: value.channel },
                  'Dropped pubsub event for inactive channel',
                )
              }
            }
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
}

function concat(...args: any) {
  return args.filter(Boolean).join('/')
}

function getChannelName<T extends TAnyEventContract>(
  contract: T,
  options: T['options'],
) {
  const key = options ? serializerOptions(options) : ''
  assert(contract.name, 'Event contract must have a name')
  return concat(contract.name, key)
}

function serializerOptions(options: Exclude<SubcriptionOptions, null>): string {
  const hash = createHash('sha1')
  const serialized = Object.entries(options)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join(';')
  hash.update(serialized)
  return hash.digest('base64url')
}

function mergeEventStreams(
  streams: Readable[],
  signal?: AbortSignal,
): Readable {
  const destination = new PassThrough({
    signal,
    objectMode: true,
    readableObjectMode: true,
    writableObjectMode: true,
  })

  let ended = 0

  for (const source of streams) {
    source.pipe(destination, { end: false })
    source.once('end', () => {
      ended++
      if (ended === streams.length) {
        destination.end()
      }
    })
  }

  return destination
}
