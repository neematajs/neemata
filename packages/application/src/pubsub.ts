import assert from 'node:assert'
import { createHash } from 'node:crypto'
import { PassThrough, Readable } from 'node:stream'
import { isAbortError } from '@nmtjs/common'
import type {
  SubcriptionOptions,
  TAnyEventContract,
  TAnySubscriptionContract,
} from '@nmtjs/contract'
import { Hook, type Logger } from '@nmtjs/core'
import type { t } from '@nmtjs/type'
import type { ApplicationRegistry } from './registry.ts'

export type PubSubAdapterEvent = { channel: string; payload: any }

export interface PubSubAdapter {
  publish(channel: string, payload: any): Promise<boolean>
  subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PubSubAdapterEvent>
}

export type PubSubChannel = {
  stream: Readable
  subscription: TAnySubscriptionContract
  event: TAnyEventContract
  eventKey: string
}

export class PubSub {
  readonly subscriptions = new Map<string, PubSubChannel>()

  constructor(
    protected readonly application: {
      logger: Logger
      registry: ApplicationRegistry
    },
    protected readonly options?: {
      adapter: PubSubAdapter
    },
  ) {
    if (!this.options?.adapter) {
      this.application.logger.warn(
        'PubSub adapter is not configured, attempting to subscribe to events will fail',
      )
    } else {
      this.application.registry.registerHook(Hook.BeforeTerminate, async () => {
        for (const { stream } of this.subscriptions.values()) {
          stream.destroy()
        }
      })
    }
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
              data: t.infer.decoded.output<Contract['events'][K]['payload']>
            }
          }[keyof Contract['events']]
        : {
            [K in keyof Events]: K extends keyof Contract['events']
              ? {
                  event: K
                  data: t.infer.decoded.output<Contract['events'][K]['payload']>
                }
              : never
          }[keyof Events]
    >
  } {
    assert(this.options?.adapter, 'PubSub adapter is not configured')

    const eventKeys =
      Object.keys(events).length === 0
        ? Object.keys(subscription.events)
        : Object.keys(events)

    const streams = Array(eventKeys.length)

    for (const index in eventKeys) {
      const eventKey = eventKeys[index]
      const channel = getChannelName(subscription, eventKey, options)
      if (this.subscriptions.has(channel)) {
        streams[index] = this.subscriptions.get(channel)!.stream
      } else {
        const iterable = this.options.adapter.subscribe(channel, signal)
        const stream = this.createEventStream(iterable)
        stream.on('close', () => this.subscriptions.delete(channel))
        streams[index] = stream
        const event = subscription.events[eventKey] as TAnyEventContract
        this.subscriptions.set(channel, {
          subscription,
          event,
          stream,
          eventKey,
        })
      }
    }

    return mergeEventStreams(streams, signal)
  }

  publish<
    S extends TAnySubscriptionContract,
    E extends S['events'][keyof S['events']],
  >(
    subscription: S,
    event: E,
    options: S['options'],
    data: t.infer.decoded.input<E['payload']>,
  ): Promise<boolean> {
    assert(this.options?.adapter, 'PubSub adapter is not configured')
    const channel = getChannelName(subscription, event.name, options)
    const subscriptionChannel = this.subscriptions.get(channel)

    if (!subscriptionChannel) {
      return Promise.resolve(false)
    }

    try {
      const payload = subscriptionChannel.event.payload.encode(data)
      return this.options.adapter.publish(channel, payload)
    } catch (error: any) {
      this.application.logger.error(
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

function getChannelName<
  T extends TAnySubscriptionContract,
  E extends keyof T['events'],
>(contract: T, eventKey: E, options: T['options']) {
  const event = (contract.events as any)[eventKey] as TAnyEventContract
  const key = serializerOptions(options)
  assert(contract.name, 'Subscription contract must have a name')
  assert(event.name, 'Event contract must have a name')
  return concat(contract.name, event.name, key)
}

function serializerOptions(options: SubcriptionOptions): string {
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

export class SimplePubSubAdapter implements PubSubAdapter {
  private readonly channels = new Map<string, PassThrough>()

  async publish(channel: string, payload: any): Promise<boolean> {
    const stream = this.channels.get(channel)
    if (!stream) return false
    stream.write(payload)
    return true
  }

  async *subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PubSubAdapterEvent> {
    let stream = this.channels.get(channel)

    if (!stream) {
      stream = new PassThrough({ objectMode: true })
      this.channels.set(channel, stream)
    }

    try {
      signal?.throwIfAborted()
      for await (const data of stream) {
        signal?.throwIfAborted()
        yield { channel, payload: data }
      }
    } catch (error) {
      if (isAbortError(error)) return
      throw error
    } finally {
      this.channels.delete(channel)
    }
  }
}
