import EventEmitter, { on } from 'node:events'

import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { OperationQueue } from '@nmtjs/common'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'
import type { PubSubLogger } from './utils.ts'
import { isAbortError } from './utils.ts'

export type RedisPubSubClient = Redis | Valkey

type ChannelState = {
  listeners: number
  subscribed: boolean
  // SUBSCRIBE and UNSUBSCRIBE run one at a time and each converges the broker
  // on the listener count at the moment it runs, so a listener arriving while
  // the last one leaves is never left on a channel the broker dropped.
  queue: OperationQueue
}

export class RedisPubSubAdapter implements PubSubAdapter {
  protected readonly events = new EventEmitter<{ [key: string]: [any] }>()
  protected readonly channels = new Map<string, ChannelState>()
  protected subClient?: RedisPubSubClient
  protected controller?: AbortController

  constructor(
    protected readonly client: RedisPubSubClient,
    protected readonly logger?: PubSubLogger,
  ) {}

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

    const subClient = this.subClient
    // Cleared first so released channels skip UNSUBSCRIBE: quitting drops
    // every subscription, and the command would fail on the closed connection.
    this.subClient = undefined
    this.controller?.abort()

    // Let in-flight SUBSCRIBE/UNSUBSCRIBE commands settle before quitting.
    await Promise.all(
      Array.from(this.channels.values(), ({ queue }) => queue.waitIdle()),
    )
    this.channels.clear()
    this.events.removeAllListeners()

    await subClient?.quit()

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

  async subscribe(
    channel: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<PubSubMessage>> {
    if (!this.subClient || !this.controller)
      throw new Error('Redis client not initialized')

    // A dependent signal per subscription keeps its listeners off the
    // adapter-wide signal.
    const finalSignal = AbortSignal.any(
      signal ? [signal, this.controller.signal] : [this.controller.signal],
    )
    finalSignal.throwIfAborted()

    this.logger?.debug({ channel }, 'Opening channel listener')

    // Attach the local listener before Redis confirms SUBSCRIBE; otherwise a
    // message delivered immediately after broker readiness can be dropped.
    const messages = on(this.events, channel, { signal: finalSignal })

    const state = this.channelState(channel)
    state.listeners++

    let released: Promise<void> | undefined
    const release = () => {
      finalSignal.removeEventListener('abort', release)
      released ??= this.release(channel, state)
      return released
    }
    // Abort releases even a subscription whose messages are never read.
    finalSignal.addEventListener('abort', release, { once: true })

    try {
      await state.queue.run(() => this.reconcile(channel, state))
      finalSignal.throwIfAborted()
    } catch (error) {
      await messages.return?.()
      await release()
      throw error
    }

    this.logger?.trace(
      { channel, listeners: state.listeners },
      'Channel listener attached',
    )

    return this.deliver(channel, messages, release)
  }

  protected async *deliver(
    channel: string,
    messages: AsyncIterableIterator<unknown[]>,
    release: () => Promise<void>,
  ): AsyncGenerator<PubSubMessage> {
    try {
      for await (const [data] of messages) {
        this.logger?.trace({ channel }, 'Delivering message')
        yield { channel, data } as PubSubMessage
      }
    } catch (error: any) {
      if (isAbortError(error)) {
        this.logger?.trace({ channel }, 'Channel listener gracefully aborted')
        return
      }
      this.logger?.warn({ channel, error }, 'Channel listener error')
      throw error
    } finally {
      await release()
    }
  }

  protected channelState(channel: string): ChannelState {
    let state = this.channels.get(channel)
    if (!state) {
      state = { listeners: 0, subscribed: false, queue: new OperationQueue() }
      this.channels.set(channel, state)
    }
    return state
  }

  protected release(channel: string, state: ChannelState): Promise<void> {
    state.listeners--
    this.logger?.trace(
      { channel, listeners: state.listeners },
      'Channel listener detached',
    )
    // A SUBSCRIBE this issues is on behalf of a remaining listener whose own
    // queued reconcile retries it and reports the failure.
    return state.queue
      .run(() => this.reconcile(channel, state))
      .catch(() => undefined)
  }

  protected async reconcile(channel: string, state: ChannelState) {
    const subClient = this.subClient
    if (!subClient) {
      state.subscribed = false
    } else if (state.listeners > 0 && !state.subscribed) {
      await subClient.subscribe(channel)
      state.subscribed = true
      this.logger?.debug(
        { channel, listeners: state.listeners },
        'Subscribed channel',
      )
    } else if (state.listeners === 0 && state.subscribed) {
      state.subscribed = false
      try {
        await subClient.unsubscribe(channel)
        this.logger?.debug({ channel }, 'Unsubscribed channel')
      } catch (error) {
        this.logger?.warn({ channel, error }, 'Failed to unsubscribe channel')
      }
    }

    if (
      state.listeners === 0 &&
      !state.subscribed &&
      state.queue.pending === 1 &&
      this.channels.get(channel) === state
    )
      this.channels.delete(channel)
  }
}

/**
 * The adapter does not manage the passed client's connection, so it must
 * already be connected. Dispose the adapter before closing the client.
 */
export async function createRedisAdapter(
  client: RedisPubSubClient,
  logger?: PubSubLogger,
) {
  const adapter = new RedisPubSubAdapter(client, logger)
  await adapter.initialize()
  return adapter
}
