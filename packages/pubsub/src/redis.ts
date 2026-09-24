import EventEmitter, { on } from 'node:events'

import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import { OperationQueue } from '@nmtjs/common'

import type { PubSubAdapter, PubSubMessage } from './adapter.ts'
import type { PubSubLogger } from './utils.ts'
import { isAbortError, PubSubConnectionLostError } from './utils.ts'

export type RedisPubSubClient = Redis | Valkey

type ChannelState = {
  listeners: number
  subscribed: boolean
  // SUBSCRIBE and UNSUBSCRIBE run one at a time and each converges the broker
  // on the listener count at the moment it runs, so a listener arriving while
  // the last one leaves is never left on a channel the broker dropped.
  queue: OperationQueue
  // Aborted when the last listener leaves while a SUBSCRIBE waits for the
  // connection, so the releases queued behind it drain during an outage.
  idle?: AbortController
  // A release reconcile is queued and has not started. It converges on the
  // listener count when it runs, so later releases need not queue another.
  releasing: boolean
}

export class RedisPubSubAdapter implements PubSubAdapter {
  protected readonly events = new EventEmitter<{ [key: string]: [any] }>()
  protected readonly channels = new Map<string, ChannelState>()
  // Subscriptions whose channel is subscribed on the current connection, each
  // aborted with PubSubConnectionLostError when that connection closes.
  protected readonly established = new Set<AbortController>()
  protected subClient?: RedisPubSubClient
  protected controller?: AbortController
  // Aborted when the connection closes: the driver never settles a command
  // that was in flight then, as it does not resend it after the reconnect.
  protected connection = new AbortController()
  // Channels waiting for the connection. Kept apart from the client's own
  // listeners so an aborted wait leaves nothing behind during an outage.
  protected readonly statusWaiters = new Set<() => void>()

  constructor(
    protected readonly client: RedisPubSubClient,
    protected readonly logger?: PubSubLogger,
  ) {}

  async initialize() {
    this.logger?.debug('Initializing adapter')

    // Redis requires a dedicated connection for pub/sub. The adapter recovers
    // from a drop itself: resubscribing silently would hide the gap
    // subscribers must recover, and a command queued or resent for a later
    // connection would leave the broker out of step with the channel map, so
    // commands are only sent on a ready connection.
    this.subClient = this.client.duplicate({
      lazyConnect: true,
      autoResubscribe: false,
      autoResendUnfulfilledCommands: false,
      enableOfflineQueue: false,
    })

    await this.subClient.connect()

    this.controller = new AbortController()
    this.connection = new AbortController()

    this.subClient.on('message', this.onMessage)
    this.subClient.on('close', this.onClose)
    this.subClient.on('ready', this.onStatus)
    this.subClient.on('end', this.onStatus)

    this.logger?.trace('Adapter initialized')
  }

  async dispose() {
    this.logger?.debug('Disposing adapter')

    const subClient = this.subClient
    // Detached first, so disposal ends subscriptions as aborted rather than
    // as lost to the connection it closes.
    subClient?.off('message', this.onMessage)
    subClient?.off('close', this.onClose)
    subClient?.off('ready', this.onStatus)
    subClient?.off('end', this.onStatus)
    // Cleared first so released channels skip UNSUBSCRIBE: disconnecting
    // drops every subscription, and the command would fail on the closed
    // connection.
    this.subClient = undefined
    this.controller?.abort()
    this.onStatus()
    this.connection.abort(this.controller?.signal.reason)

    // Unlike QUIT, this also stops a pending reconnect, and a subscriber
    // connection has no replies worth waiting for.
    subClient?.disconnect()

    await Promise.all(
      Array.from(this.channels.values(), ({ queue }) => queue.waitIdle()),
    )
    this.channels.clear()
    this.events.removeAllListeners()

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

    const lost = new AbortController()
    // A dependent signal per subscription keeps its listeners off the
    // adapter-wide signal.
    const finalSignal = AbortSignal.any(
      signal
        ? [signal, this.controller.signal, lost.signal]
        : [this.controller.signal, lost.signal],
    )
    finalSignal.throwIfAborted()

    this.logger?.debug({ channel }, 'Opening channel listener')

    // Attach the local listener before Redis confirms SUBSCRIBE; otherwise a
    // message delivered immediately after broker readiness can be dropped.
    const messages = on(this.events, channel, { signal: finalSignal })

    const state = this.channelState(channel)
    state.listeners++

    let released = false
    // Not awaited anywhere: the release can queue behind a SUBSCRIBE that
    // waits for the connection to come back.
    const release = () => {
      if (released) return
      released = true
      finalSignal.removeEventListener('abort', release)
      this.established.delete(lost)
      this.release(channel, state)
    }
    // Abort releases even a subscription whose messages are never read.
    finalSignal.addEventListener('abort', release, { once: true })

    try {
      // Waits out an outage before queueing, so an opening aborted meanwhile
      // leaves nothing behind in a queue another listener's SUBSCRIBE holds.
      if (!(await this.connected(finalSignal))) finalSignal.throwIfAborted()
      // An abort stops waiting on a SUBSCRIBE held back by a later drop; the
      // queued reconcile still runs, and the release queued after it
      // converges the broker.
      await untilAborted(
        state.queue.run(async () => {
          await this.reconcile(channel, state)
          // Marked within the queued task, so no connection loss can reset
          // the channel between its SUBSCRIBE and this.
          if (!released) this.established.add(lost)
        }),
        finalSignal,
      )
    } catch (error) {
      await messages.return?.()
      release()
      // Disposal rejects the pending command, which is not the cause.
      finalSignal.throwIfAborted()
      throw error
    }

    this.logger?.trace(
      { channel, listeners: state.listeners },
      'Channel listener attached',
    )

    return this.deliver(channel, messages, lost.signal, release)
  }

  protected async *deliver(
    channel: string,
    messages: AsyncIterableIterator<unknown[]>,
    lost: AbortSignal,
    release: () => void,
  ): AsyncGenerator<PubSubMessage> {
    try {
      for await (const [data] of messages) {
        // `on()` hands out its backlog before it surfaces the abort. The loss
        // goes first: the subscriber refetches anyway, and a slow reader
        // would otherwise learn of the gap only after its whole backlog.
        lost.throwIfAborted()
        this.logger?.trace({ channel }, 'Delivering message')
        yield { channel, data } as PubSubMessage
      }
    } catch (error: any) {
      if (lost.aborted) {
        this.logger?.trace({ channel }, 'Channel listener lost its connection')
        throw lost.reason
      }
      if (isAbortError(error)) {
        this.logger?.trace({ channel }, 'Channel listener gracefully aborted')
        return
      }
      this.logger?.warn({ channel, error }, 'Channel listener error')
      throw error
    } finally {
      release()
    }
  }

  protected readonly onMessage = (channel: string, message: string) => {
    try {
      const parsed = JSON.parse(message)
      this.logger?.trace({ channel }, 'Received message')
      this.events.emit(channel, parsed)
    } catch (error) {
      this.logger?.error({ channel, error }, 'Failed to parse message')
    }
  }

  protected readonly onStatus = () => {
    for (const settle of this.statusWaiters) settle()
  }

  // Emitted on every drop, including each failed reconnect attempt, before
  // the next connection is ready.
  protected readonly onClose = () => {
    const error = new PubSubConnectionLostError()
    this.connection.abort(error)
    this.connection = new AbortController()

    // The broker dropped every subscription with the connection.
    for (const state of this.channels.values()) state.subscribed = false

    // Subscriptions still opening are left alone: they subscribe once the
    // connection is back, so an outage does not fail them on every attempt.
    const established = Array.from(this.established)
    this.established.clear()
    if (established.length === 0) return
    this.logger?.warn(
      { subscriptions: established.length },
      'Subscriber connection lost',
    )
    for (const lost of established) lost.abort(error)
  }

  protected channelState(channel: string): ChannelState {
    let state = this.channels.get(channel)
    if (!state) {
      state = {
        listeners: 0,
        subscribed: false,
        releasing: false,
        queue: new OperationQueue(),
      }
      this.channels.set(channel, state)
    }
    return state
  }

  protected release(channel: string, state: ChannelState) {
    state.listeners--
    if (state.listeners === 0) state.idle?.abort()
    this.logger?.trace(
      { channel, listeners: state.listeners },
      'Channel listener detached',
    )
    if (state.releasing) return
    state.releasing = true
    // A SUBSCRIBE this issues is on behalf of a remaining listener whose own
    // queued reconcile retries it and reports the failure.
    state.queue
      .run(() => {
        state.releasing = false
        return this.reconcile(channel, state)
      })
      .catch(() => undefined)
  }

  protected async reconcile(channel: string, state: ChannelState) {
    if (!this.subClient) {
      state.subscribed = false
    } else if (state.listeners > 0 && !state.subscribed) {
      const idle = new AbortController()
      state.idle = idle
      const ready = await this.connected(idle.signal).finally(() => {
        state.idle = undefined
      })
      // The last listener may have left while the connection was down.
      if (ready && state.listeners > 0) {
        const [subClient, connection] = ready
        await untilAborted(subClient.subscribe(channel), connection)
        state.subscribed = true
        this.logger?.debug(
          { channel, listeners: state.listeners },
          'Subscribed channel',
        )
      }
    } else if (state.listeners === 0 && state.subscribed) {
      state.subscribed = false
      // Status changes before the close event is emitted. A connection that
      // is down already dropped the subscription, and the command could only
      // fail.
      if (this.subClient.status === 'ready') {
        try {
          await untilAborted(
            this.subClient.unsubscribe(channel),
            this.connection.signal,
          )
          this.logger?.debug({ channel }, 'Unsubscribed channel')
        } catch (error) {
          // Losing the connection or disposing drops the subscription anyway.
          if (
            !(error instanceof PubSubConnectionLostError) &&
            !isAbortError(error)
          )
            this.logger?.warn(
              { channel, error },
              'Failed to unsubscribe channel',
            )
        }
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

  /**
   * Waits out a reconnect, and fails once the client stops reconnecting.
   * Resolves with nothing if `idle` aborts first.
   */
  protected async connected(
    idle: AbortSignal,
  ): Promise<[RedisPubSubClient, AbortSignal] | undefined> {
    for (;;) {
      if (idle.aborted) return undefined
      this.controller?.signal.throwIfAborted()
      const subClient = this.subClient
      if (!subClient || !this.controller)
        throw new Error('Redis client not initialized')
      if (subClient.status === 'ready')
        return [subClient, this.connection.signal]
      if (subClient.status === 'end') throw new PubSubConnectionLostError()
      await new Promise<void>((resolve) => {
        const settle = () => {
          this.statusWaiters.delete(settle)
          idle.removeEventListener('abort', settle)
          resolve()
        }
        this.statusWaiters.add(settle)
        idle.addEventListener('abort', settle, { once: true })
      })
    }
  }
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
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
