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

import { PubSubAdapter } from '../injectables.ts'

export type PubSubAdapterEvent = { channel: string; payload: any }

export interface PubSubAdapterType {
  publish(channel: string, payload: any): Promise<boolean>
  subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PubSubAdapterEvent>
  initialize(): Promise<void>
  dispose(): Promise<void>
}

export type PubSubChannel = {
  stream: Readable
  subscription: TAnySubscriptionContract
  event: TAnyEventContract
}

export type PubSubOptions = { logger: Logger; container: Container }

export class PubSub {
  readonly subscriptions = new Map<string, PubSubChannel>()

  constructor(protected readonly options: PubSubOptions) {}

  protected get adapter() {
    return this.options.container.get(PubSubAdapter)
  }

  subscribe<
    Contract extends TAnySubscriptionContract,
    Events extends {
      [K in keyof Contract['events']]?: true
    },
  >(
    subscription: Contract,
    events: Events,
    options: Contract['options'],
    signal?: AbortSignal,
  ): Omit<Readable, typeof Symbol.asyncIterator> & {
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
  } {
    assert(this.adapter, 'PubSub adapter is not configured')

    const eventKeys =
      Object.keys(events).length === 0
        ? Object.keys(subscription.events)
        : Object.keys(events)

    const streams = Array(eventKeys.length)

    for (const index in eventKeys) {
      const event = subscription.events[eventKeys[index]]
      const channel = getChannelName(event, options)
      if (this.subscriptions.has(channel)) {
        streams[index] = this.subscriptions.get(channel)!.stream
      } else {
        const iterable = this.adapter.subscribe(channel, signal)
        const stream = this.createEventStream(iterable)
        stream.on('close', () => this.subscriptions.delete(channel))
        streams[index] = stream
        this.subscriptions.set(channel, { subscription, event, stream })
      }
    }

    return mergeEventStreams(streams, signal)
  }

  async publish<
    S extends TAnySubscriptionContract,
    E extends S['events'][keyof S['events']],
  >(
    event: E,
    options: S['options'],
    data: t.infer.decode.input<E['payload']>,
  ): Promise<boolean> {
    assert(this.adapter, 'PubSub adapter is not configured')

    const channel = getChannelName(event, options)

    try {
      const payload = event.payload.encode(data)
      return await this.adapter.publish(channel, payload)
    } catch (error: any) {
      this.options.logger.error(
        `Failed to publish event "${event.name}" on channel "${channel}": ${error.message}`,
      )
      return Promise.reject(error)
    }
  }

  private createEventStream(
    iterable: AsyncGenerator<PubSubAdapterEvent>,
  ): Readable {
    const { subscriptions } = this
    return new Readable({
      objectMode: true,
      read() {
        iterable.next().then(
          ({ value, done }) => {
            if (done) {
              this.push(null)
            } else {
              const subscription = subscriptions.get(value.channel)
              if (subscription) {
                const { event } = subscription
                try {
                  const data = event.payload.decode(value.payload)
                  this.push({ event: event.name, data })
                } catch (error: any) {
                  this.destroy(error)
                }
              }
            }
          },
          (error) => {
            if (isAbortError(error)) {
              this.push(null)
            } else {
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
