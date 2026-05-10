import EventEmitter, { on } from 'node:events'

import type { RuntimePlugin } from '@nmtjs/application'
import type { Logger } from '@nmtjs/core'
import { isAbortError } from '@nmtjs/common'
import { createFactoryInjectable } from '@nmtjs/core'

import type { Store } from '../types.ts'
import type {
  SubscriptionAdapterEvent,
  SubscriptionAdapterType,
} from './manager.ts'
import { storeConfig, subscriptionAdapter } from '../injectables.ts'
import { createStoreClient } from '../store/index.ts'

export class RedisSubscriptionAdapter implements SubscriptionAdapterType {
  protected readonly events = new EventEmitter()
  protected readonly listeners = new Map<string, number>()
  protected readonly logger?: Logger
  protected subscriberClient?: Store

  constructor(
    protected readonly client: Store,
    logger?: Logger,
  ) {
    this.logger = logger?.child({ component: RedisSubscriptionAdapter.name })
  }

  async initialize() {
    this.logger?.debug('Initializing Redis adapter')

    // Create a dedicated subscriber client (Redis requires separate clients for pub/sub)
    this.subscriberClient = this.client.duplicate()

    // Set up message handler
    this.subscriberClient.on('message', (channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message)
        this.logger?.trace({ channel }, 'Received Redis message')
        this.events.emit(channel, parsed)
      } catch (error) {
        this.logger?.warn({ channel, error }, 'Failed to parse Redis message')
      }
    })

    this.logger?.debug('Redis adapter initialized')
  }

  async dispose() {
    this.logger?.debug('Disposing Redis adapter')

    if (this.subscriberClient) {
      await this.subscriberClient.quit()
      this.subscriberClient = undefined
    }

    this.logger?.debug('Redis adapter disposed')
  }

  async publish(channel: string, payload: any): Promise<boolean> {
    this.logger?.trace({ channel }, 'Publishing Redis message')

    try {
      await this.client.publish(channel, JSON.stringify(payload))
      this.logger?.trace({ channel }, 'Published Redis message')
      return true
    } catch (error) {
      this.logger?.warn({ channel, error }, 'Failed to publish Redis message')
      return false
    }
  }

  async *subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SubscriptionAdapterEvent> {
    if (!this.subscriberClient) {
      throw new Error('RedisSubscriptionAdapter not initialized')
    }

    this.logger?.debug({ channel }, 'Opening Redis channel listener')

    if (!this.listeners.has(channel)) {
      await this.subscriberClient.subscribe(channel)
      this.listeners.set(channel, 1)
      this.logger?.debug({ channel, listeners: 1 }, 'Subscribed Redis channel')
    } else {
      const listeners = this.listeners.get(channel)! + 1
      this.listeners.set(channel, listeners)
      this.logger?.trace(
        { channel, listeners },
        'Reusing Redis channel listener',
      )
    }

    try {
      signal?.throwIfAborted()
      for await (const [payload] of on(this.events, channel, { signal })) {
        this.logger?.trace({ channel }, 'Delivering Redis message')
        yield { channel, payload }
      }
    } catch (error: any) {
      if (isAbortError(error)) {
        this.logger?.trace({ channel }, 'Redis channel listener aborted')
        throw error
      }

      this.logger?.warn({ channel, error }, 'Redis channel listener failed')
    } finally {
      const count = this.listeners.get(channel)
      if (count !== undefined) {
        if (count > 1) {
          const listeners = count - 1
          this.listeners.set(channel, listeners)
          this.logger?.trace(
            { channel, listeners },
            'Detached Redis channel listener',
          )
        } else {
          await this.subscriberClient?.unsubscribe(channel)
          this.listeners.delete(channel)
          this.logger?.debug(
            { channel, listeners: 0 },
            'Unsubscribed Redis channel',
          )
        }
      }
    }
  }
}

export const RedisSubscriptionAdapterPlugin = (): RuntimePlugin => {
  return {
    name: 'redis-subscription-adapter',
    hooks: {
      'lifecycle:beforeInitialize': async (ctx) => {
        const adapter = await ctx.container.resolve(
          createFactoryInjectable({
            dependencies: { config: storeConfig },
            factory: async ({ config }) => {
              const connection = await createStoreClient(config)
              const adapter = new RedisSubscriptionAdapter(
                connection,
                ctx.logger,
              )
              await adapter.initialize()
              return { adapter, connection }
            },
            pick: ({ adapter }) => adapter,
            dispose: ({ connection }) => connection.quit(),
          }),
        )
        ctx.container.provide(subscriptionAdapter, adapter)
      },
    },
  }
}
