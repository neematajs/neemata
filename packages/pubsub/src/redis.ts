import EventEmitter, { on } from 'node:events'

import type { AnyInjectable, Logger } from '@nmtjs/core'
import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { anyAbortSignal, isAbortError } from '@nmtjs/common'
import {
  CoreInjectables,
  createFactoryInjectable,
  createValueInjectable,
  forkLogger,
  isInjectable,
} from '@nmtjs/core'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'

export type RedisPubSubClient = Redis | Valkey

// One entry per broker subscription, shared by every listener on the channel.
type ChannelSubscription = { count: number; ready: Promise<unknown> }

export class RedisPubSubAdapter implements PubSubAdapter {
  protected readonly events = new EventEmitter<
    Record<string, [PubSubMessage['data']]>
  >()
  protected readonly subscriptions = new Map<string, ChannelSubscription>()
  protected readonly logger?: Logger
  protected subClient?: RedisPubSubClient
  protected controller?: AbortController

  constructor(
    protected readonly client: RedisPubSubClient,
    logger?: Logger,
  ) {
    this.logger = logger ? forkLogger(logger, 'RedisPubSubAdapter') : undefined
  }

  async initialize() {
    this.logger?.debug('Initializing adapter')

    // Redis requires separate clients for pub/sub
    this.subClient = this.client.duplicate({ lazyConnect: true })

    await this.subClient.connect()

    this.controller = new AbortController()

    this.subClient.on('message', (channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message)
        this.logger?.trace({ channel }, 'Received message')
        this.events.emit(channel, parsed)
      } catch (error) {
        this.logger?.error({ channel, error }, 'Failed to parse message')
      }
    })

    this.logger?.trace('Adapter initialized')
  }

  async dispose() {
    this.logger?.debug('Disposing adapter')

    this.controller?.abort()

    this.events.removeAllListeners()

    if (this.subClient) {
      await this.subClient.quit()
      this.subClient = undefined
    }

    this.logger?.trace('Adapter disposed')
  }

  async publish(channel: string, payload: unknown): Promise<boolean> {
    this.logger?.trace({ channel }, 'Publishing message')

    try {
      await this.client.publish(channel, JSON.stringify(payload))
      this.logger?.trace({ channel }, 'Published message')
      return true
    } catch (error) {
      this.logger?.warn({ channel, error }, 'Failed to publish message')
      return false
    }
  }

  async *subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PubSubMessage> {
    if (!this.subClient || !this.controller) {
      throw new Error('Redis client not initialized')
    }

    this.logger?.debug({ channel }, 'Opening channel listener')

    let acquired = false

    try {
      const listenerSignal = anyAbortSignal(signal, this.controller.signal)

      listenerSignal.throwIfAborted()

      // Attach the local listener before Redis confirms SUBSCRIBE; otherwise a
      // message delivered immediately after broker readiness can be dropped.
      const messages = on(this.events, channel, { signal: listenerSignal })

      await this.acquire(channel, this.subClient)
      acquired = true

      for await (const args of messages) {
        this.logger?.trace({ channel }, 'Delivering message')
        yield { channel, data: args[0] }
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.logger?.trace({ channel }, 'Channel listener gracefully aborted')
        return
      }
      this.logger?.warn({ channel, error }, 'Channel listener error')
      throw error
    } finally {
      if (acquired) await this.release(channel)
    }
  }

  private async acquire(channel: string, subClient: RedisPubSubClient) {
    const existing = this.subscriptions.get(channel)

    if (existing) {
      existing.count++
      await existing.ready
      this.logger?.trace(
        { channel, listeners: existing.count },
        'Reusing channel subscription',
      )
      return
    }

    const subscription: ChannelSubscription = {
      count: 1,
      ready: subClient.subscribe(channel),
    }
    this.subscriptions.set(channel, subscription)
    await subscription.ready
    this.logger?.debug({ channel, listeners: 1 }, 'Subscribed channel')
  }

  private async release(channel: string) {
    const subscription = this.subscriptions.get(channel)
    if (!subscription) return

    if (subscription.count > 1) {
      subscription.count--
      this.logger?.trace(
        { channel, listeners: subscription.count },
        'Channel listener detached',
      )
      return
    }

    // the entry survives until UNSUBSCRIBE resolves, so a listener arriving
    // meanwhile joins it instead of racing a second SUBSCRIBE
    await this.subClient?.unsubscribe(channel)
    this.subscriptions.delete(channel)
    this.logger?.debug(
      { channel, listeners: 0 },
      'Channel listener unsubscribed',
    )
  }
}

export const createRedisAdapter = (
  /**
   * Redis client instance
   * Note: adapter does not manage passed client connection state, so it should be an already connected client
   */
  client: RedisPubSubClient | AnyInjectable<RedisPubSubClient>,
) => {
  return createFactoryInjectable({
    dependencies: {
      client: isInjectable(client) ? client : createValueInjectable(client),
      logger: CoreInjectables.logger,
    },
    create: async ({ client, logger }) => {
      const adapter = new RedisPubSubAdapter(client, logger)
      await adapter.initialize()
      return adapter
    },
    dispose: (adapter) => adapter.dispose(),
  })
}
