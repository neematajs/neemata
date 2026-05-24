import { Readable } from 'node:stream'

import type { Logger } from '@nmtjs/core'
import { isAbortError } from '@nmtjs/common'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'

export type PubSubChannel = { channel: string; stream: Readable }

export type PubSubStream<Payload = unknown> = Omit<
  Readable,
  typeof Symbol.asyncIterator
> & { [Symbol.asyncIterator]: () => AsyncIterator<PubSubMessage<Payload>> }

export type SubscribeFn = <Payload = unknown>(
  channel: string,
  signal?: AbortSignal,
) => Promise<PubSubStream<Payload>>

export type PublishFn = (channel: string, payload: unknown) => Promise<boolean>

export type PubSubManagerOptions = { logger: Logger; adapter: PubSubAdapter }

export class PubSubManager {
  readonly channels = new Map<string, PubSubChannel>()
  protected readonly logger: Logger

  constructor(protected readonly options: PubSubManagerOptions) {
    this.logger = options.logger.child({ component: PubSubManager.name })
  }

  subscribe = async <Payload = unknown>(
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

  publish: PublishFn = async (channel, payload) => {
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
}
