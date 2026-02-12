import type { Future, TypeProvider } from '@nmtjs/common'
import type { TAnyRouterContract } from '@nmtjs/contract'
import type { ProtocolBlobMetadata, ProtocolVersion } from '@nmtjs/protocol'
import type {
  BaseClientFormat,
  MessageContext,
  ProtocolVersionInterface,
  ServerMessageTypePayload,
} from '@nmtjs/protocol/client'
import {
  anyAbortSignal,
  createFuture,
  MAX_UINT32,
  noopFn,
  withTimeout,
} from '@nmtjs/common'
import {
  ClientMessageType,
  ConnectionType,
  ErrorCode,
  ProtocolBlob,
  ServerMessageType,
} from '@nmtjs/protocol'
import {
  ProtocolError,
  ProtocolServerBlobStream,
  ProtocolServerRPCStream,
  ProtocolServerStream,
  versions,
} from '@nmtjs/protocol/client'

import type {
  ClientDisconnectReason,
  ClientPlugin,
  ClientPluginInstance,
} from './plugins/types.ts'
import type { BaseClientTransformer } from './transformers.ts'
import type { ClientCallResponse, ClientTransportFactory } from './transport.ts'
import type {
  ClientCallers,
  ClientCallOptions,
  ResolveAPIRouterRoutes,
} from './types.ts'
import { EventEmitter } from './events.ts'
import { ClientStreams, ServerStreams } from './streams.ts'

export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
} from '@nmtjs/protocol'

export * from './types.ts'

export class ClientError extends ProtocolError {}

export type ProtocolClientCall = Future<any> & {
  procedure: string
  signal?: AbortSignal
}

const DEFAULT_RECONNECT_REASON = 'connect_error'

export interface BaseClientOptions<
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
> {
  contract: RouterContract
  protocol: ProtocolVersion
  format: BaseClientFormat
  application?: string
  timeout?: number
  plugins?: ClientPlugin[]
  safe?: SafeCall
}

/**
 * @todo Add error logging in ClientStreamPull rejection handler for easier debugging
 * @todo Consider edge case where callId/streamId overflow at MAX_UINT32 with existing entries
 */
export abstract class BaseClient<
  TransportFactory extends ClientTransportFactory<
    any,
    any
  > = ClientTransportFactory<any, any>,
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> extends EventEmitter<{
  connected: []
  disconnected: [reason: ClientDisconnectReason]
  pong: [nonce: number]
}> {
  _!: {
    routes: ResolveAPIRouterRoutes<
      RouterContract,
      InputTypeProvider,
      OutputTypeProvider
    >
    safe: SafeCall
  }

  protected abstract readonly transformer: BaseClientTransformer

  abstract call: ClientCallers<this['_']['routes'], SafeCall, false>
  abstract stream: ClientCallers<this['_']['routes'], SafeCall, true>

  protected calls = new Map<number, ProtocolClientCall>()
  protected transport: TransportFactory extends ClientTransportFactory<
    any,
    any,
    infer T
  >
    ? T
    : never
  protected protocol: ProtocolVersionInterface
  protected messageContext!: MessageContext | null
  protected clientStreams = new ClientStreams()
  protected serverStreams = new ServerStreams()
  protected rpcStreams = new ServerStreams()
  protected callId = 0
  protected streamId = 0
  protected cab: AbortController | null = null
  protected connecting: Promise<void> | null = null

  protected _state: 'connected' | 'disconnected' = 'disconnected'
  protected _lastDisconnectReason: ClientDisconnectReason = 'server'
  protected _disposed = false

  protected pingNonce = 0
  protected pendingPings = new Map<number, Future<void>>()
  protected plugins: ClientPluginInstance[] = []

  private clientDisconnectAsReconnect = false
  private clientDisconnectOverrideReason: string | null = null

  private authValue: any

  constructor(
    readonly options: BaseClientOptions<RouterContract, SafeCall>,
    readonly transportFactory: TransportFactory,
    readonly transportOptions: TransportFactory extends ClientTransportFactory<
      any,
      infer U
    >
      ? U
      : never,
  ) {
    super()

    this.protocol = versions[options.protocol]

    const { format, protocol } = this.options

    this.transport = this.transportFactory(
      { protocol, format },
      this.transportOptions,
    ) as any

    this.plugins = this.options.plugins?.map((plugin) => plugin(this)) ?? []
    for (const plugin of this.plugins) {
      plugin.onInit?.()
    }
  }

  dispose() {
    this._disposed = true
    this.stopAllPendingPings('dispose')
    for (let i = this.plugins.length - 1; i >= 0; i--) {
      this.plugins[i].dispose?.()
    }
  }

  get state() {
    return this._state
  }

  get lastDisconnectReason() {
    return this._lastDisconnectReason
  }

  get transportType() {
    return this.transport.type
  }

  isDisposed() {
    return this._disposed
  }

  requestReconnect(reason?: string) {
    return this.disconnect({ reconnect: true, reason })
  }

  get auth() {
    return this.authValue
  }

  set auth(value) {
    this.authValue = value
  }

  connect() {
    if (this._state === 'connected') return Promise.resolve()
    if (this.connecting) return this.connecting

    if (this._disposed) return Promise.reject(new Error('Client is disposed'))

    const _connect = async () => {
      if (this.transport.type === ConnectionType.Bidirectional) {
        this.cab = new AbortController()
        const protocol = this.protocol
        const serverStreams = this.serverStreams
        const transport = {
          send: (buffer) => {
            this.send(buffer).catch(noopFn)
          },
        }
        this.messageContext = {
          transport,
          encoder: this.options.format,
          decoder: this.options.format,
          addClientStream: (blob) => {
            const streamId = this.getStreamId()
            return this.clientStreams.add(blob.source, streamId, blob.metadata)
          },
          addServerStream(streamId, metadata) {
            const stream = new ProtocolServerBlobStream(metadata, {
              pull: (controller) => {
                transport.send(
                  protocol.encodeMessage(
                    this,
                    ClientMessageType.ServerStreamPull,
                    { streamId, size: 65535 /* 64kb by default */ },
                  ),
                )
              },
              close: () => {
                serverStreams.remove(streamId)
              },
              readableStrategy: { highWaterMark: 0 },
            })
            serverStreams.add(streamId, stream)
            return ({ signal }: { signal?: AbortSignal } = {}) => {
              if (signal)
                signal.addEventListener(
                  'abort',
                  () => {
                    transport.send(
                      protocol.encodeMessage(
                        this,
                        ClientMessageType.ServerStreamAbort,
                        { streamId },
                      ),
                    )
                    serverStreams.abort(streamId)
                  },
                  { once: true },
                )
              return stream
            }
          },
          streamId: this.getStreamId.bind(this),
        }
        return this.transport.connect({
          auth: this.auth,
          application: this.options.application,
          onMessage: this.onMessage.bind(this),
          onConnect: this.onConnect.bind(this),
          onDisconnect: this.onDisconnect.bind(this),
        })
      }
    }

    let emitDisconnectOnFailure: 'server' | 'client' | (string & {}) | null =
      null

    this.connecting = _connect()
      .then(() => {
        this._state = 'connected'
      })
      .catch((error) => {
        if (this.transport.type === ConnectionType.Bidirectional) {
          emitDisconnectOnFailure = DEFAULT_RECONNECT_REASON
        }
        throw error
      })
      .finally(() => {
        this.connecting = null

        if (emitDisconnectOnFailure && !this._disposed) {
          this._state = 'disconnected'
          this._lastDisconnectReason = emitDisconnectOnFailure
          void this.onDisconnect(emitDisconnectOnFailure)
        }
      })

    return this.connecting
  }

  async disconnect(options: { reconnect?: boolean; reason?: string } = {}) {
    if (this.transport.type === ConnectionType.Bidirectional) {
      // Ensure connect() won't short-circuit while the transport is closing.
      this._state = 'disconnected'
      this._lastDisconnectReason = 'client'

      if (options.reconnect) {
        this.clientDisconnectAsReconnect = true
        this.clientDisconnectOverrideReason = options.reason ?? 'server'
      } else {
        this.clientDisconnectAsReconnect = false
        this.clientDisconnectOverrideReason = null
      }

      this.cab!.abort()
      await this.transport.disconnect()
      this.messageContext = null
      this.cab = null
    }
  }

  blob(
    source: Blob | ReadableStream | string | AsyncIterable<Uint8Array>,
    metadata?: ProtocolBlobMetadata,
  ) {
    return ProtocolBlob.from(source, metadata)
  }

  protected async _call(
    procedure: string,
    payload: any,
    options: ClientCallOptions = {},
  ) {
    const timeout = options.timeout ?? this.options.timeout
    const controller = new AbortController()

    // attach all abort signals
    const signals: AbortSignal[] = [controller.signal]

    if (timeout) signals.push(AbortSignal.timeout(timeout))
    if (options.signal) signals.push(options.signal)
    if (this.cab?.signal) signals.push(this.cab.signal)

    const signal = signals.length ? anyAbortSignal(...signals) : undefined

    const callId = this.getCallId()
    const call = createFuture() as ProtocolClientCall
    call.procedure = procedure
    call.signal = signal

    this.calls.set(callId, call)

    // Check if signal is already aborted before proceeding
    if (signal?.aborted) {
      this.calls.delete(callId)
      const error = new ProtocolError(
        ErrorCode.ClientRequestError,
        signal.reason,
      )
      call.reject(error)
    } else {
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            call.reject(
              new ProtocolError(ErrorCode.ClientRequestError, signal!.reason),
            )
            if (
              this.transport.type === ConnectionType.Bidirectional &&
              this.messageContext
            ) {
              const buffer = this.protocol.encodeMessage(
                this.messageContext,
                ClientMessageType.RpcAbort,
                { callId },
              )
              this.send(buffer).catch(noopFn)
            }
          },
          { once: true },
        )
      }

      try {
        const transformedPayload = this.transformer.encode(procedure, payload)
        if (this.transport.type === ConnectionType.Bidirectional) {
          const buffer = this.protocol.encodeMessage(
            this.messageContext!,
            ClientMessageType.Rpc,
            { callId, procedure, payload: transformedPayload },
          )
          await this.send(buffer, signal)
        } else {
          const response = await this.transport.call(
            {
              application: this.options.application,
              format: this.options.format,
              auth: this.auth,
            },
            { callId, procedure, payload: transformedPayload },
            { signal, _stream_response: options._stream_response },
          )
          this.handleCallResponse(callId, response)
        }
      } catch (error) {
        call.reject(error)
      }
    }

    const result = call.promise.then(
      (value) => {
        if (value instanceof ProtocolServerRPCStream) {
          return value.createAsyncIterable(() => {
            controller.abort()
          })
        }
        controller.abort()
        return value
      },
      (err) => {
        controller.abort()
        throw err
      },
    )

    if (this.options.safe) {
      return await result
        .then((result) => ({ result }))
        .catch((error) => ({ error }))
        .finally(() => {
          this.calls.delete(callId)
        })
    } else {
      return await result.finally(() => {
        this.calls.delete(callId)
      })
    }
  }

  protected async onConnect() {
    this._state = 'connected'
    this._lastDisconnectReason = 'server'
    for (const plugin of this.plugins) {
      await plugin.onConnect?.()
    }
    this.emit('connected')
  }

  protected async onDisconnect(reason: ClientDisconnectReason) {
    const effectiveReason =
      reason === 'client' && this.clientDisconnectAsReconnect
        ? (this.clientDisconnectOverrideReason ?? 'server')
        : reason

    this.clientDisconnectAsReconnect = false
    this.clientDisconnectOverrideReason = null

    this._state = 'disconnected'
    this._lastDisconnectReason = effectiveReason

    // Connection is gone, never keep old message context around.
    this.messageContext = null

    this.stopAllPendingPings(effectiveReason)

    // Fail-fast: do not keep pending calls around across disconnects.
    if (this.calls.size) {
      const error = new ProtocolError(
        ErrorCode.ConnectionError,
        'Disconnected',
        { reason: effectiveReason },
      )
      for (const call of this.calls.values()) {
        call.reject(error)
      }
      this.calls.clear()
    }

    if (this.cab) {
      try {
        this.cab.abort(reason)
      } catch {
        this.cab.abort()
      }
      this.cab = null
    }

    this.emit('disconnected', effectiveReason)

    for (let i = this.plugins.length - 1; i >= 0; i--) {
      await this.plugins[i].onDisconnect?.(effectiveReason)
    }

    void this.clientStreams.clear(effectiveReason)
    void this.serverStreams.clear(effectiveReason)
    void this.rpcStreams.clear(effectiveReason)
  }

  protected nextPingNonce() {
    if (this.pingNonce >= MAX_UINT32) this.pingNonce = 0
    return this.pingNonce++
  }

  ping(timeout: number, signal?: AbortSignal) {
    if (
      !this.messageContext ||
      this.transport.type !== ConnectionType.Bidirectional
    ) {
      return Promise.reject(new Error('Client is not connected'))
    }

    const nonce = this.nextPingNonce()
    const future = createFuture<void>()
    this.pendingPings.set(nonce, future)

    const buffer = this.protocol.encodeMessage(
      this.messageContext,
      ClientMessageType.Ping,
      { nonce },
    )

    return this.send(buffer, signal)
      .then(() =>
        withTimeout(future.promise, timeout, new Error('Heartbeat timeout')),
      )
      .finally(() => {
        this.pendingPings.delete(nonce)
      })
  }

  protected stopAllPendingPings(reason?: any) {
    if (!this.pendingPings.size) return
    const error = new Error('Heartbeat stopped', { cause: reason })
    for (const pending of this.pendingPings.values()) pending.reject(error)
    this.pendingPings.clear()
  }

  protected async onMessage(buffer: ArrayBufferView) {
    if (!this.messageContext) return

    const message = this.protocol.decodeMessage(this.messageContext, buffer)
    for (const plugin of this.plugins) {
      plugin.onServerMessage?.(message, buffer)
    }

    switch (message.type) {
      case ServerMessageType.RpcResponse:
        this.handleRPCResponseMessage(message)
        break
      case ServerMessageType.RpcStreamResponse:
        this.handleRPCStreamResponseMessage(message)
        break
      case ServerMessageType.Pong: {
        const pending = this.pendingPings.get(message.nonce)
        if (pending) {
          this.pendingPings.delete(message.nonce)
          pending.resolve()
        }
        this.emit('pong', message.nonce)
        break
      }
      case ServerMessageType.Ping: {
        if (this.messageContext) {
          const buffer = this.protocol.encodeMessage(
            this.messageContext,
            ClientMessageType.Pong,
            { nonce: message.nonce },
          )
          this.send(buffer).catch(noopFn)
        }
        break
      }
      case ServerMessageType.RpcStreamChunk:
        this.rpcStreams.push(message.callId, message.chunk)
        break
      case ServerMessageType.RpcStreamEnd:
        this.rpcStreams.end(message.callId)
        this.calls.delete(message.callId)
        break
      case ServerMessageType.RpcStreamAbort:
        this.rpcStreams.abort(message.callId)
        this.calls.delete(message.callId)
        break
      case ServerMessageType.ServerStreamPush:
        this.serverStreams.push(message.streamId, message.chunk)
        break
      case ServerMessageType.ServerStreamEnd:
        this.serverStreams.end(message.streamId)
        break
      case ServerMessageType.ServerStreamAbort:
        this.serverStreams.abort(message.streamId)
        break
      case ServerMessageType.ClientStreamPull:
        this.clientStreams.pull(message.streamId, message.size).then(
          (chunk) => {
            if (chunk) {
              const buffer = this.protocol.encodeMessage(
                this.messageContext!,
                ClientMessageType.ClientStreamPush,
                { streamId: message.streamId, chunk },
              )
              this.send(buffer).catch(noopFn)
            } else {
              const buffer = this.protocol.encodeMessage(
                this.messageContext!,
                ClientMessageType.ClientStreamEnd,
                { streamId: message.streamId },
              )
              this.send(buffer).catch(noopFn)
              this.clientStreams.end(message.streamId)
            }
          },
          () => {
            const buffer = this.protocol.encodeMessage(
              this.messageContext!,
              ClientMessageType.ClientStreamAbort,
              { streamId: message.streamId },
            )
            this.send(buffer).catch(noopFn)
            this.clientStreams.remove(message.streamId)
          },
        )
        break
      case ServerMessageType.ClientStreamAbort:
        this.clientStreams.abort(message.streamId)
        break
    }
  }

  private handleRPCResponseMessage(
    message: ServerMessageTypePayload[ServerMessageType.RpcResponse],
  ) {
    const { callId, result, error } = message
    const call = this.calls.get(callId)
    if (!call) return
    if (error) {
      call.reject(new ProtocolError(error.code, error.message, error.data))
    } else {
      try {
        const transformed = this.transformer.decode(call.procedure, result)
        call.resolve(transformed)
      } catch (error) {
        call.reject(
          new ProtocolError(
            ErrorCode.ClientRequestError,
            'Unable to decode response',
            error,
          ),
        )
      }
    }
  }

  private handleRPCStreamResponseMessage(
    message: ServerMessageTypePayload[ServerMessageType.RpcStreamResponse],
  ) {
    const call = this.calls.get(message.callId)
    if (message.error) {
      if (!call) return
      call.reject(
        new ProtocolError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      )
    } else {
      if (call) {
        const { procedure, signal } = call
        const stream = new ProtocolServerRPCStream({
          start: (controller) => {
            if (signal) {
              if (signal.aborted) controller.error(signal.reason)
              else
                signal.addEventListener(
                  'abort',
                  () => {
                    controller.error(signal.reason)
                    if (this.rpcStreams.has(message.callId)) {
                      this.rpcStreams.remove(message.callId)
                      this.calls.delete(message.callId)
                      if (this.messageContext) {
                        const buffer = this.protocol.encodeMessage(
                          this.messageContext,
                          ClientMessageType.RpcAbort,
                          { callId: message.callId, reason: signal.reason },
                        )
                        this.send(buffer).catch(noopFn)
                      }
                    }
                  },
                  { once: true },
                )
            }
          },
          transform: (chunk) => {
            return this.transformer.decode(
              procedure,
              this.options.format.decode(chunk),
            )
          },
          pull: () => {
            const buffer = this.protocol.encodeMessage(
              this.messageContext!,
              ClientMessageType.RpcPull,
              { callId: message.callId },
            )
            this.send(buffer).catch(noopFn)
          },
          readableStrategy: { highWaterMark: 0 },
        })
        this.rpcStreams.add(message.callId, stream)
        call.resolve(stream)
      } else {
        // Call not found, but stream response received
        // This can happen if the call was aborted or timed out
        // Need to send an abort for the stream to avoid resource leaks from server side
        if (this.messageContext) {
          const buffer = this.protocol.encodeMessage(
            this.messageContext,
            ClientMessageType.RpcAbort,
            { callId: message.callId },
          )
          this.send(buffer).catch(noopFn)
        }
      }
    }
  }

  private handleCallResponse(callId: number, response: ClientCallResponse) {
    const call = this.calls.get(callId)

    if (response.type === 'rpc_stream') {
      if (call) {
        const stream = new ProtocolServerStream({
          transform: (chunk) => {
            return this.transformer.decode(
              call.procedure,
              this.options.format.decode(chunk),
            )
          },
        })
        this.rpcStreams.add(callId, stream)
        call.resolve(({ signal }: { signal?: AbortSignal }) => {
          response.stream.pipeTo(stream.writable, { signal }).catch(noopFn)
          return stream
        })
      } else {
        // Call not found, but stream response received
        // This can happen if the call was aborted or timed out
        // Need to cancel the stream to avoid resource leaks from server side
        response.stream.cancel().catch(noopFn)
      }
    } else if (response.type === 'blob') {
      if (call) {
        const { metadata, source } = response
        const stream = new ProtocolServerBlobStream(metadata)
        this.serverStreams.add(this.getStreamId(), stream)
        call.resolve(({ signal }: { signal?: AbortSignal }) => {
          source.pipeTo(stream.writable, { signal }).catch(noopFn)
          return stream
        })
      } else {
        // Call not found, but blob response received
        // This can happen if the call was aborted or timed out
        // Need to cancel the stream to avoid resource leaks from server side
        response.source.cancel().catch(noopFn)
      }
    } else if (response.type === 'rpc') {
      if (!call) return
      try {
        const transformed = this.transformer.decode(
          call.procedure,
          response.result,
        )
        call.resolve(transformed)
      } catch (error) {
        call.reject(
          new ProtocolError(
            ErrorCode.ClientRequestError,
            'Unable to decode response',
            error,
          ),
        )
      }
    }
  }

  protected send(buffer: ArrayBufferView, signal?: AbortSignal) {
    if (this.transport.type === ConnectionType.Unidirectional)
      throw new Error('Invalid transport type for send')
    return this.transport.send(buffer, { signal })
  }

  protected getStreamId() {
    if (this.streamId >= MAX_UINT32) {
      this.streamId = 0
    }
    return this.streamId++
  }

  protected getCallId() {
    if (this.callId >= MAX_UINT32) {
      this.callId = 0
    }
    return this.callId++
  }
}
