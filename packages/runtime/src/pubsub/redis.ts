import EventEmitter, { on } from 'node:events'

import { isAbortError } from '@nmtjs/common'
import { createFactoryInjectable, provide } from '@nmtjs/core'

import type { RuntimePlugin } from '../core/plugin.ts'
import type { Store } from '../types.ts'
import type { PubSubAdapterEvent, PubSubAdapterType } from './manager.ts'
import { pubSubAdapter, storeConfig } from '../injectables.ts'
import { createStoreClient } from '../store/index.ts'

export class RedisPubSubAdapter implements PubSubAdapterType {
  protected readonly events = new EventEmitter()
  protected readonly listeners = new Map<string, number>()
  protected subscriberClient?: Store

  constructor(protected readonly client: Store) {}

  async initialize() {
    // Create a dedicated subscriber client (Redis requires separate clients for pub/sub)
    this.subscriberClient = this.client.duplicate()

    // Set up message handler
    this.subscriberClient.on('message', (channel: string, message: string) => {
      try {
        const parsed = JSON.parse(message)
        this.events.emit(channel, parsed)
      } catch {}
    })
  }

  async dispose() {
    if (this.subscriberClient) {
      await this.subscriberClient.quit()
      this.subscriberClient = undefined
    }
  }

  async publish(channel: string, payload: any): Promise<boolean> {
    try {
      await this.client.publish(channel, JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  async *subscribe(
    channel: string,
    signal?: AbortSignal,
  ): AsyncGenerator<PubSubAdapterEvent> {
    if (!this.subscriberClient) {
      throw new Error('RedisPubSubAdapter not initialized')
    }

    if (!this.listeners.has(channel)) {
      await this.subscriberClient.subscribe(channel)
      this.listeners.set(channel, 1)
    } else {
      this.listeners.set(channel, this.listeners.get(channel)! + 1)
    }

    try {
      signal?.throwIfAborted()
      for await (const [payload] of on(this.events, channel, { signal })) {
        yield { channel, payload }
      }
    } catch (error: any) {
      if (isAbortError(error)) throw error
    } finally {
      const count = this.listeners.get(channel)
      if (count !== undefined) {
        if (count > 1) {
          this.listeners.set(channel, count - 1)
        } else {
          await this.subscriberClient?.unsubscribe(channel)
          this.listeners.delete(channel)
        }
      }
    }
  }
}

export const RedisPubSubAdapterPlugin = (): RuntimePlugin => {
  return {
    name: 'pubsub-redis-adapter',
    hooks: {
      'lifecycle:afterInitialize': async (ctx) => {
        await ctx.container.provide([
          provide(
            pubSubAdapter,
            createFactoryInjectable({
              dependencies: { config: storeConfig },
              factory: async ({ config }) => {
                const connection = await createStoreClient(config)
                const adapter = new RedisPubSubAdapter(connection)
                await adapter.initialize()
                return { adapter, connection }
              },
              pick: ({ adapter }) => adapter,
              dispose: ({ connection }) => connection.quit(),
            }),
          ),
        ])
      },
    },
  }
}
