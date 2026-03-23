import type { ProtocolVersion } from '@nmtjs/protocol'
import type {
  BaseClientFormat,
  MessageContext,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/client'
import { noopFn } from '@nmtjs/common'
import { ConnectionType } from '@nmtjs/protocol'
import { ProtocolError, versions } from '@nmtjs/protocol/client'

import type {
  ClientPlugin,
  ClientPluginContext,
  ClientPluginEvent,
  ClientPluginInstance,
  ReconnectConfig,
  StreamEvent,
} from './plugins/types.ts'
import type {
  ClientDisconnectReason,
  ClientTransport,
  TransportCallContext,
  TransportCallOptions,
  TransportCallResponse,
  TransportRpcParams,
} from './transport.ts'
import { EventEmitter } from './events.ts'

export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
} from '@nmtjs/protocol'

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'

export interface ClientCoreOptions {
  protocol: ProtocolVersion
  format: BaseClientFormat
  application?: string
  plugins?: ClientPlugin[]
}

export class ClientError extends ProtocolError {}

const DEFAULT_RECONNECT_TIMEOUT = 1000
const DEFAULT_MAX_RECONNECT_TIMEOUT = 60000
const DEFAULT_CONNECT_ERROR_REASON = 'connect_error'

const sleep = (ms: number, signal?: AbortSignal) => {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()

    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

const computeReconnectDelay = (ms: number) => {
  if (globalThis.window) {
    const jitter = Math.floor(ms * 0.2 * Math.random())
    return ms + jitter
  }

  return ms
}

export class ClientCore extends EventEmitter<{
  message: [message: unknown, raw: ArrayBufferView]
  connected: []
  disconnected: [reason: ClientDisconnectReason]
  state_changed: [state: ConnectionState, previous: ConnectionState]
  pong: [nonce: number]
}> {
  readonly protocol: ProtocolVersionInterface
  readonly format: BaseClientFormat
  readonly application?: string

  auth: any
  messageContext: MessageContext | null = null

  #state: ConnectionState = 'idle'
  #messageContextFactory: (() => MessageContext) | null = null
  #cab: AbortController | null = null
  #connecting: Promise<void> | null = null
  #disposed = false
  #plugins: ClientPluginInstance[] = []
  #lastDisconnectReason: ClientDisconnectReason = 'server'
  #clientDisconnectAsReconnect = false
  #clientDisconnectOverrideReason: ClientDisconnectReason | null = null
  #reconnectConfig: ReconnectConfig | null = null
  #reconnectPauseReasons = new Set<string>()
  #reconnectController: AbortController | null = null
  #reconnectPromise: Promise<void> | null = null
  #reconnectTimeout = DEFAULT_RECONNECT_TIMEOUT
  #reconnectImmediate = false

  constructor(
    options: ClientCoreOptions,
    readonly transport: ClientTransport,
  ) {
    super()

    this.protocol = versions[options.protocol]
    this.format = options.format
    this.application = options.application
  }

  get state() {
    return this.#state
  }

  get lastDisconnectReason() {
    return this.#lastDisconnectReason
  }

  get transportType() {
    return this.transport.type
  }

  get connectionSignal() {
    return this.#cab?.signal
  }

  isDisposed() {
    return this.#disposed
  }

  initPlugins(plugins: ClientPlugin[] = [], context: ClientPluginContext) {
    if (this.#plugins.length > 0) return

    this.#plugins = plugins.map((plugin) => plugin(context))
    for (const plugin of this.#plugins) {
      plugin.onInit?.()
    }
  }

  setMessageContextFactory(factory: () => MessageContext) {
    this.#messageContextFactory = factory
  }

  configureReconnect(config: ReconnectConfig | null) {
    this.#reconnectConfig = config
    this.#reconnectTimeout = config?.initialTimeout ?? DEFAULT_RECONNECT_TIMEOUT
    this.#reconnectImmediate = false

    if (!config) {
      this.#cancelReconnectLoop()
      return
    }

    if (
      this.transport.type === ConnectionType.Bidirectional &&
      this.#state === 'disconnected' &&
      this.#lastDisconnectReason !== 'client'
    ) {
      this.#ensureReconnectLoop()
    }
  }

  setReconnectPauseReason(reason: string, active: boolean) {
    if (active) {
      this.#reconnectPauseReasons.add(reason)
    } else {
      this.#reconnectPauseReasons.delete(reason)
    }
  }

  triggerReconnect() {
    if (
      this.#disposed ||
      !this.#reconnectConfig ||
      this.transport.type !== ConnectionType.Bidirectional
    ) {
      return
    }

    this.#reconnectImmediate = true

    if (this.#state === 'disconnected' || this.#state === 'idle') {
      this.#ensureReconnectLoop()
    }
  }

  connect() {
    if (this.#disposed) {
      return Promise.reject(new Error('Client is disposed'))
    }

    if (this.#state === 'connected') return Promise.resolve()
    if (this.#connecting) return this.#connecting

    if (this.transport.type === ConnectionType.Unidirectional) {
      return this.#handleConnected()
    }

    if (!this.#messageContextFactory) {
      return Promise.reject(
        new Error('Message context factory is not configured'),
      )
    }

    this.#setState('connecting')
    this.#cab = new AbortController()
    this.messageContext = this.#messageContextFactory()

    this.#connecting = this.transport
      .connect({
        auth: this.auth,
        application: this.application,
        onMessage: (message) => {
          void this.#onMessage(message)
        },
        onConnect: () => {
          void this.#handleConnected()
        },
        onDisconnect: (reason) => {
          void this.#handleDisconnected(reason)
        },
      })
      .catch(async (error) => {
        this.messageContext = null
        this.#cab = null
        await this.#handleDisconnected(DEFAULT_CONNECT_ERROR_REASON)
        throw error
      })
      .finally(() => {
        this.#connecting = null
      })

    return this.#connecting
  }

  async disconnect(reason: ClientDisconnectReason = 'client') {
    this.#cancelReconnectLoop()

    if (this.transport.type === ConnectionType.Unidirectional) {
      await this.#handleDisconnected(reason)
      return
    }

    if (this.#state === 'idle' || this.#state === 'disconnected') {
      this.#lastDisconnectReason = reason
      this.#setState('disconnected')
      return
    }

    this.#setState('disconnecting')

    if (this.#cab && !this.#cab.signal.aborted) {
      try {
        this.#cab.abort(reason)
      } catch {
        this.#cab.abort()
      }
    }

    try {
      await this.transport.disconnect()

      if (this.#state === 'disconnecting') {
        await this.#handleDisconnected(reason)
      }
    } catch (error) {
      await this.#handleDisconnected(reason)
      throw error
    }
  }

  requestReconnect(reason: ClientDisconnectReason = 'server') {
    if (this.transport.type !== ConnectionType.Bidirectional) {
      return Promise.resolve()
    }

    this.#clientDisconnectAsReconnect = true
    this.#clientDisconnectOverrideReason = reason

    return this.disconnect('client')
  }

  dispose() {
    if (this.#disposed) return

    this.#disposed = true
    this.#cancelReconnectLoop()
    this.messageContext = null

    if (this.#cab && !this.#cab.signal.aborted) {
      try {
        this.#cab.abort('dispose')
      } catch {
        this.#cab.abort()
      }
    }

    if (
      this.transport.type === ConnectionType.Bidirectional &&
      (this.#state === 'connecting' || this.#state === 'connected')
    ) {
      void this.transport.disconnect().catch(noopFn)
    }

    for (let i = this.#plugins.length - 1; i >= 0; i--) {
      this.#plugins[i].dispose?.()
    }
  }

  send(buffer: ArrayBufferView, signal?: AbortSignal) {
    if (this.transport.type !== ConnectionType.Bidirectional) {
      throw new Error('Invalid transport type for send')
    }

    return this.transport.send(buffer, { signal })
  }

  transportCall(
    context: TransportCallContext,
    rpc: TransportRpcParams,
    options: TransportCallOptions,
  ): Promise<TransportCallResponse> {
    if (this.transport.type !== ConnectionType.Unidirectional) {
      throw new Error('Invalid transport type for call')
    }

    return this.transport.call(context, rpc, options)
  }

  emitClientEvent(event: ClientPluginEvent) {
    for (const plugin of this.#plugins) {
      try {
        const result = plugin.onClientEvent?.(event)
        Promise.resolve(result).catch(noopFn)
      } catch {}
    }
  }

  emitStreamEvent(event: StreamEvent) {
    this.emitClientEvent({
      kind: 'stream_event',
      timestamp: Date.now(),
      ...event,
    })
  }

  async #onMessage(buffer: ArrayBufferView) {
    if (!this.messageContext) return

    const message = this.protocol.decodeMessage(this.messageContext, buffer)

    for (const plugin of this.#plugins) {
      plugin.onServerMessage?.(message, buffer)
    }

    this.emitClientEvent({
      kind: 'server_message',
      timestamp: Date.now(),
      messageType: message.type,
      rawByteLength: buffer.byteLength,
      body: message,
    })

    this.emit('message', message, buffer)
  }

  async #handleConnected() {
    this.#reconnectTimeout =
      this.#reconnectConfig?.initialTimeout ?? DEFAULT_RECONNECT_TIMEOUT
    this.#reconnectImmediate = false

    this.#setState('connected')
    this.#lastDisconnectReason = 'server'

    this.emitClientEvent({
      kind: 'connected',
      timestamp: Date.now(),
      transportType:
        this.transport.type === ConnectionType.Bidirectional
          ? 'bidirectional'
          : 'unidirectional',
    })

    for (const plugin of this.#plugins) {
      await plugin.onConnect?.()
    }

    this.emit('connected')
  }

  async #handleDisconnected(reason: ClientDisconnectReason) {
    const effectiveReason =
      reason === 'client' && this.#clientDisconnectAsReconnect
        ? (this.#clientDisconnectOverrideReason ?? 'server')
        : reason

    this.#clientDisconnectAsReconnect = false
    this.#clientDisconnectOverrideReason = null

    const shouldSkip =
      this.#state === 'disconnected' &&
      this.messageContext === null &&
      this.#lastDisconnectReason === effectiveReason

    this.messageContext = null

    if (this.#cab) {
      if (!this.#cab.signal.aborted) {
        try {
          this.#cab.abort(reason)
        } catch {
          this.#cab.abort()
        }
      }
      this.#cab = null
    }

    if (shouldSkip) return

    this.#lastDisconnectReason = effectiveReason
    this.#setState('disconnected')

    this.emitClientEvent({
      kind: 'disconnected',
      timestamp: Date.now(),
      reason: effectiveReason,
    })

    this.emit('disconnected', effectiveReason)

    for (let i = this.#plugins.length - 1; i >= 0; i--) {
      await this.#plugins[i].onDisconnect?.(effectiveReason)
    }

    if (this.#shouldReconnect(effectiveReason)) {
      this.#ensureReconnectLoop()
    }
  }

  #setState(next: ConnectionState) {
    if (next === this.#state) return

    const previous = this.#state
    this.#state = next

    this.emitClientEvent({
      kind: 'state_changed',
      timestamp: Date.now(),
      state: next,
      previous,
    })

    this.emit('state_changed', next, previous)
  }

  #shouldReconnect(reason: ClientDisconnectReason) {
    return (
      !this.#disposed &&
      !!this.#reconnectConfig &&
      this.transport.type === ConnectionType.Bidirectional &&
      reason !== 'client'
    )
  }

  #cancelReconnectLoop() {
    this.#reconnectImmediate = false
    this.#reconnectController?.abort()
    this.#reconnectController = null
    this.#reconnectPromise = null
  }

  #ensureReconnectLoop() {
    if (this.#reconnectPromise || !this.#reconnectConfig) return

    const signal = new AbortController()
    this.#reconnectController = signal

    this.#reconnectPromise = (async () => {
      while (
        !signal.signal.aborted &&
        !this.#disposed &&
        this.#reconnectConfig &&
        (this.#state === 'disconnected' || this.#state === 'idle') &&
        this.#lastDisconnectReason !== 'client'
      ) {
        if (this.#reconnectPauseReasons.size) {
          await sleep(1000, signal.signal)
          continue
        }

        const delay = this.#reconnectImmediate
          ? 0
          : computeReconnectDelay(this.#reconnectTimeout)
        this.#reconnectImmediate = false

        if (delay > 0) {
          await sleep(delay, signal.signal)
        }

        const currentState = this.state

        if (
          signal.signal.aborted ||
          this.#disposed ||
          !this.#reconnectConfig ||
          currentState === 'connected' ||
          currentState === 'connecting'
        ) {
          break
        }

        const previousTimeout = this.#reconnectTimeout

        await this.connect().catch(noopFn)

        if (this.state !== 'connected' && this.#reconnectConfig) {
          this.#reconnectTimeout = Math.min(
            previousTimeout * 2,
            this.#reconnectConfig.maxTimeout ?? DEFAULT_MAX_RECONNECT_TIMEOUT,
          )
        }
      }
    })().finally(() => {
      if (this.#reconnectController === signal) {
        this.#reconnectController = null
      }
      this.#reconnectPromise = null
    })
  }
}
