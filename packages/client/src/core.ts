import type { ClientMessageType, ProtocolVersion } from '@nmtjs/protocol'
import type {
  BaseClientCodec,
  ClientMessageTypePayload,
  MessageContext,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/client'
import { noopFn } from '@nmtjs/common'
import { ConnectionType, ErrorCode } from '@nmtjs/protocol'
import { ProtocolError, versions } from '@nmtjs/protocol/client'

import type {
  ClientEvent,
  ClientPlugin,
  ClientPluginContext,
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
import { sleep } from './utils.ts'

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'

export type ServerMessage = ReturnType<
  ProtocolVersionInterface['decodeMessage']
>

export interface ClientCoreOptions {
  protocol: ProtocolVersion
  codec: BaseClientCodec
  application?: string
  autoConnect?: boolean
}

export class ClientError extends ProtocolError {}

const DEFAULT_RECONNECT_TIMEOUT = 1000
const DEFAULT_MAX_RECONNECT_TIMEOUT = 60000
const DEFAULT_CONNECT_ERROR_REASON = 'connect_error'
const PAUSE_POLL_INTERVAL = 1000

const computeReconnectDelay = (ms: number) => {
  // jitter unconditionally: Node fleets would otherwise reconnect in lockstep
  const jitter = Math.floor(ms * 0.2 * Math.random())
  return ms + jitter
}

export class ClientCore extends EventEmitter<{
  message: [message: ServerMessage, raw: ArrayBufferView]
  connected: []
  disconnected: [reason: ClientDisconnectReason]
  state_changed: [state: ConnectionState, previous: ConnectionState]
  pong: [nonce: number]
  error: [error: ClientError]
}> {
  readonly protocol: ProtocolVersionInterface
  readonly codec: BaseClientCodec
  readonly application?: string
  readonly autoConnect: boolean

  auth?: string
  messageContext: MessageContext | null = null

  #state: ConnectionState = 'idle'
  #messageContextFactory: (() => MessageContext) | null = null
  #cab: AbortController | null = null
  #connecting: Promise<void> | null = null
  #disposed = false
  #plugins: ClientPluginInstance[] = []
  #lastDisconnectReason: ClientDisconnectReason = 'server'
  #reconnectDisconnectReason: ClientDisconnectReason | null = null
  #reconnectConfig: ReconnectConfig | null = null
  #reconnectPauseReasons = new Set<string>()
  #reconnectController: AbortController | null = null
  #reconnectTimeout = DEFAULT_RECONNECT_TIMEOUT
  #reconnectImmediate = false

  constructor(
    options: ClientCoreOptions,
    readonly transport: ClientTransport,
  ) {
    super()

    this.protocol = versions[options.protocol]
    this.codec = options.codec
    this.application = options.application
    this.autoConnect = options.autoConnect ?? false
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

  shouldConnectOnCall() {
    return (
      this.autoConnect &&
      !this.#disposed &&
      this.#lastDisconnectReason !== 'client' &&
      // a running reconnect loop owns connecting, unless this call arrived
      // while its attempt is already in flight
      (this.#state === 'connecting' || !this.#reconnectController) &&
      (this.#state === 'idle' ||
        this.#state === 'connecting' ||
        this.#state === 'disconnected')
    )
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
    this.#resetBackoff()

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
          this.#onMessage(message)
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
    this.#cab?.abort(reason)

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

    // the transport is closed as a client disconnect, but consumers must see
    // the reason that asked for the reconnect
    this.#reconnectDisconnectReason = reason

    return this.disconnect('client')
  }

  dispose() {
    if (this.#disposed) return

    this.#disposed = true
    this.#cancelReconnectLoop()
    this.messageContext = null
    this.#cab?.abort('dispose')

    if (
      this.transport.type === ConnectionType.Bidirectional &&
      (this.#state === 'connecting' || this.#state === 'connected')
    ) {
      void this.transport.disconnect().catch(noopFn)
    }

    for (const plugin of this.#plugins.toReversed()) {
      plugin.dispose?.()
    }
  }

  send(buffer: ArrayBufferView, signal?: AbortSignal) {
    if (this.transport.type !== ConnectionType.Bidirectional) {
      throw new Error('Invalid transport type for send')
    }

    return this.transport.send(buffer, { signal })
  }

  // returns null when there is no message context, i.e. nothing to send over
  sendMessage<T extends ClientMessageType>(
    type: T,
    payload: ClientMessageTypePayload[T],
    signal?: AbortSignal,
  ) {
    if (!this.messageContext) return null

    const buffer = this.protocol.encodeMessage(
      this.messageContext,
      type,
      payload,
    )

    return this.send(buffer, signal)
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

  emitClientEvent(event: ClientEvent) {
    if (!this.#plugins.length) return

    const timestamped = { ...event, timestamp: Date.now() }

    for (const plugin of this.#plugins) {
      try {
        const result = plugin.onClientEvent?.(timestamped)
        Promise.resolve(result).catch(noopFn)
      } catch {
        // plugin telemetry is observational: a throwing sink must not break
        // the call or message flow that produced the event
      }
    }
  }

  emitStreamEvent(event: StreamEvent) {
    this.emitClientEvent({ kind: 'stream_event', ...event })
  }

  #onMessage(buffer: ArrayBufferView) {
    if (!this.messageContext) return

    let message: ServerMessage
    try {
      message = this.protocol.decodeMessage(this.messageContext, buffer)
    } catch (cause) {
      // a malformed server frame must not become an unhandled rejection
      this.emit(
        'error',
        new ClientError(
          ErrorCode.ClientRequestError,
          'Unable to decode server message',
          cause,
        ),
      )
      return
    }

    for (const plugin of this.#plugins) {
      plugin.onServerMessage?.(message, buffer)
    }

    this.emitClientEvent({
      kind: 'server_message',
      messageType: message.type,
      rawByteLength: buffer.byteLength,
      body: message,
    })

    this.emit('message', message, buffer)
  }

  async #handleConnected() {
    this.#resetBackoff()
    this.#setState('connected')
    this.#lastDisconnectReason = 'server'

    this.emitClientEvent({
      kind: 'connected',
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
    const requested = this.#reconnectDisconnectReason
    const effectiveReason =
      reason === 'client' && requested !== null ? requested : reason

    this.#reconnectDisconnectReason = null

    const shouldSkip =
      this.#state === 'disconnected' &&
      this.messageContext === null &&
      this.#lastDisconnectReason === effectiveReason

    this.messageContext = null
    this.#cab?.abort(reason)
    this.#cab = null

    if (shouldSkip) return

    this.#lastDisconnectReason = effectiveReason
    this.#setState('disconnected')

    this.emitClientEvent({ kind: 'disconnected', reason: effectiveReason })
    this.emit('disconnected', effectiveReason)

    for (const plugin of this.#plugins.toReversed()) {
      await plugin.onDisconnect?.(effectiveReason)
    }

    if (this.#shouldReconnect(effectiveReason)) {
      this.#ensureReconnectLoop()
    }
  }

  #setState(next: ConnectionState) {
    if (next === this.#state) return

    const previous = this.#state
    this.#state = next

    this.emitClientEvent({ kind: 'state_changed', state: next, previous })
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

  #resetBackoff() {
    this.#reconnectTimeout =
      this.#reconnectConfig?.initialTimeout ?? DEFAULT_RECONNECT_TIMEOUT
    this.#reconnectImmediate = false
  }

  #cancelReconnectLoop() {
    this.#reconnectImmediate = false
    this.#reconnectController?.abort()
    this.#reconnectController = null
  }

  #ensureReconnectLoop() {
    if (this.#reconnectController || !this.#reconnectConfig) return

    const controller = new AbortController()
    const { signal } = controller
    this.#reconnectController = controller

    void (async () => {
      // checks after an await read `state`, not `#state`: the connection can
      // change while the loop is suspended, which narrowing would hide
      while (
        !signal.aborted &&
        !this.#disposed &&
        this.#reconnectConfig &&
        (this.#state === 'disconnected' || this.#state === 'idle') &&
        this.#lastDisconnectReason !== 'client'
      ) {
        if (this.#reconnectPauseReasons.size) {
          await sleep(PAUSE_POLL_INTERVAL, signal)
          continue
        }

        const delay = this.#reconnectImmediate
          ? 0
          : computeReconnectDelay(this.#reconnectTimeout)
        this.#reconnectImmediate = false

        if (delay > 0) {
          await sleep(delay, signal)
        }

        const state = this.state

        if (
          signal.aborted ||
          this.#disposed ||
          !this.#reconnectConfig ||
          state === 'connected' ||
          state === 'connecting'
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
      if (this.#reconnectController === controller) {
        this.#reconnectController = null
      }
    })
  }
}
