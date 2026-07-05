import EventEmitter, { on } from 'node:events'

import type { AnyInjectable, Logger } from '@nmtjs/core'
import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { isAbortError } from '@nmtjs/common'
import {
  CoreInjectables,
  createFactoryInjectable,
  createValueInjectable,
  forkLogger,
  isInjectable,
} from '@nmtjs/core'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'

export type RedisPubSubClient = Redis | Valkey

export class RedisPubSubAdapter implements PubSubAdapter {
  protected readonly events = new EventEmitter<{ [key: string]: [any] }>()
  protected readonly listeners = new Map<string, number>()
  protected readonly subscribtions = new Map<string, Promise<any>>()
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

    // Create a dedicated subscriber client (Redis requires separate clients for pub/sub)
    this.subClient = this.client.duplicate({ lazyConnect: true })

    await this.subClient.connect()

    this.controller = new AbortController()

    // Set up message handler
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
    if (!this.subClient) throw new Error('Redis client not initialized')

    this.logger?.debug({ channel }, 'Opening channel listener')

    let registered = false

    try {
      const controllerSignal = this.controller?.signal
      const finalSignal =
        signal && controllerSignal
          ? AbortSignal.any([signal, controllerSignal])
          : controllerSignal

      finalSignal?.throwIfAborted()

      // Attach the local listener before Redis confirms SUBSCRIBE; otherwise a
      // message delivered immediately after broker readiness can be dropped.
      const messages = on(this.events, channel, {
        signal: finalSignal,
      })

      if (!this.listeners.has(channel)) {
        this.listeners.set(channel, 1)
        const promise = this.subClient.subscribe(channel)
        this.subscribtions.set(channel, promise)
        await promise
        this.logger?.debug(
          { channel, listeners: this.listeners.get(channel) },
          'Subscribed channel',
        )
      } else {
        const listeners = this.listeners.get(channel)! + 1
        this.listeners.set(channel, listeners)
        await this.subscribtions.get(channel)
        this.logger?.trace(
          { channel, listeners },
          'Reusing channel subscription',
        )
      }

      registered = true

      for await (const args of messages) {
        this.logger?.trace({ channel }, 'Delivering message')
        yield { channel, data: args[0] }
      }
    } catch (error: any) {
      if (isAbortError(error)) {
        this.logger?.trace({ channel }, 'Channel listener gracefully aborted')
        return
      }
      this.logger?.warn({ channel, error }, 'Channel listener error')
      throw error
    } finally {
      const count = registered ? this.listeners.get(channel) : undefined
      if (count !== undefined) {
        if (count > 1) {
          const listeners = count - 1
          this.listeners.set(channel, listeners)
          this.logger?.trace(
            { channel, listeners },
            'Channel listener detached',
          )
        } else {
          await this.subClient?.unsubscribe(channel)
          this.listeners.delete(channel)
          this.logger?.debug(
            { channel, listeners: 0 },
            'Channel listener unsubscribed',
          )
        }
      }
    }
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
    dispose: async (adapter) => {
      return await adapter.dispose()
    },
  })
}
