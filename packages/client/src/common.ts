import type { Future, TypeProvider } from '@nmtjs/common'
import type { TAnyRouterContract } from '@nmtjs/contract'
import type { ProtocolVersion } from '@nmtjs/protocol'
import type {
  BaseClientFormat,
  MessageContext,
  ProtocolVersionInterface,
  ServerMessageTypePayload,
} from '@nmtjs/protocol/client'
import { createFuture, MAX_UINT32, noopFn } from '@nmtjs/common'
import {
  ClientMessageType,
  ConnectionType,
  ErrorCode,
  ServerMessageType,
} from '@nmtjs/protocol'
import {
  ClientStreams,
  ProtocolError,
  ProtocolServerBlobStream,
  ProtocolServerStream,
  ServerStreams,
  versions,
} from '@nmtjs/protocol/client'

import type { BaseClientTransformer } from './transformers.ts'
import type { ClientCallResponse, ClientTransportFactory } from './transport.ts'
import type {
  ClientCallers,
  ClientCallOptions,
  ResolveAPIRouterRoutes,
} from './types.ts'
import { EventEmitter } from './events.ts'

export {
  ErrorCode,
  ProtocolBlob,
  type ProtocolBlobMetadata,
} from '@nmtjs/protocol'

export * from './types.ts'

const uniAddStream = () => {
  throw new Error('Unidirectional transports do not support streams')
}
const uniGetStream = () => {
  throw new Error('Unidirectional transports do not support streams')
}

export class ClientError extends ProtocolError {}

export type ProtocolClientCall = Future<any> & {
  procedure: string
  signal?: AbortSignal
}

// const DEFAULT_RECONNECT_TIMEOUT = 1000

export interface BaseClientOptions<
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
> {
  contract: RouterContract
  protocol: ProtocolVersion
  format: BaseClientFormat
  application?: string
  timeout?: number
  autoreconnect?: boolean
  safe?: SafeCall
}

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
  disconnected: [reason: 'server' | 'client' | (string & {})]
}> {
  _!: {
    routes: ResolveAPIRouterRoutes<
      RouterContract,
      InputTypeProvider,
      OutputTypeProvider
    >
    safe: SafeCall
  }

  protected abstract transformer: BaseClientTransformer
  protected readonly calls = new Map<number, ProtocolClientCall>()
  abstract call: ClientCallers<this['_']['routes'], SafeCall, false>
  abstract stream: ClientCallers<this['_']['routes'], SafeCall, true>

  #transport: TransportFactory extends ClientTransportFactory<any, any, infer T>
    ? T
    : never
  #protocol: ProtocolVersionInterface
  #messageContext!: MessageContext | null

  #clientStreams = new ClientStreams()
  #serverStreams = new ServerStreams()
  #rpcStreams = new ServerStreams()
  #callId = 0
  #streamId = 0

  public auth: any

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

    this.#protocol = versions[options.protocol]

    const { format, protocol } = this.options

    this.#transport = this.transportFactory(
      { protocol, format },
      this.transportOptions,
    ) as any

    // if (this.options.autoreconnect) {
    //   this.transport.on('disconnected', async (reason) => {
    //     if (reason === 'server') {
    //       this.connect()
    //     } else if (reason === 'error') {
    //       const timeout = new Promise((resolve) =>
    //         setTimeout(resolve, this.reconnectTimeout),
    //       )
    //       const connected = new Promise((_, reject) =>
    //         this.transport.once('connected', reject),
    //       )
    //       this.reconnectTimeout += DEFAULT_RECONNECT_TIMEOUT
    //       await Promise.race([timeout, connected]).then(
    //         this.connect.bind(this),
    //         noopFn,
    //       )
    //     }
    //   })
    //   this.transport.on('connected', () => {
    //     this.reconnectTimeout = DEFAULT_RECONNECT_TIMEOUT
    //   })
    // }
  }

  setAuth(auth: any) {
    this.auth = auth
  }

  async connect() {
    if (this.#transport.type === ConnectionType.Bidirectional) {
      this.#messageContext = {
        transport: {
          send: (buffer) => {
            this.#send(buffer).catch(noopFn)
          },
        },
        encoder: this.options.format,
        decoder: this.options.format,
        clientStreams: this.#clientStreams,
        serverStreams: this.#serverStreams,
        streamId: this.#getStreamId.bind(this),
      }
      return this.#transport.connect({
        auth: this.auth,
        application: this.options.application,
        onMessage: this.onMessage.bind(this),
        onConnect: this.onConnect.bind(this),
        onDisconnect: this.onDisconnect.bind(this),
      })
    }
  }

  async disconnect() {
    if (this.#transport.type === ConnectionType.Bidirectional) {
      return await this.#transport.disconnect()
    }
  }

  protected async _call(
    procedure: string,
    payload: any,
    options: ClientCallOptions = {},
  ) {
    const timeout = options.timeout ?? this.options.timeout
    const signals: AbortSignal[] = []

    if (timeout) signals.push(AbortSignal.timeout(timeout))
    if (options.signal) signals.push(options.signal)

    const signal = signals.length === 0 ? undefined : AbortSignal.any(signals)

    const callId = this.#getCallId()
    const call = createFuture() as ProtocolClientCall
    call.procedure = procedure
    call.signal = signal

    this.calls.set(callId, call)

    if (signal) {
      if (signal.aborted) {
        call.reject(
          new ProtocolError(ErrorCode.ClientRequestError, signal.reason),
        )
      } else {
        signal.addEventListener(
          'abort',
          () => {
            call.reject(
              new ProtocolError(ErrorCode.ClientRequestError, signal.reason),
            )
            if (
              this.#transport.type === ConnectionType.Bidirectional &&
              this.#messageContext
            ) {
              const buffer = this.#protocol.encodeMessage(
                this.#messageContext,
                ClientMessageType.RpcAbort,
                { callId },
              )
              this.#send(buffer)
            }
          },
          { once: true },
        )
      }
    }

    try {
      if (this.#transport.type === ConnectionType.Bidirectional) {
        if (!this.#messageContext) throw new Error('Not connected')

        const encodedPayload = this.transformer.encode(procedure, payload)
        const buffer = this.#protocol.encodeMessage(
          this.#messageContext,
          ClientMessageType.Rpc,
          { callId, procedure, payload: encodedPayload },
        )

        await this.#send(buffer, signal)
      } else {
        const encodedPayload = this.transformer.encode(procedure, payload)
        const response = await this.#transport.call(
          {
            application: this.options.application,
            format: this.options.format,
            auth: this.auth,
          },
          { callId, procedure, payload: encodedPayload },
          { signal, _stream_response: options._stream_response, timeout },
        )
        this.#handleCallResponse(callId, response)
      }
    } catch (error) {
      call.reject(error)
    }

    if (this.options.safe) {
      return await call.promise
        .then((result) => ({ result }))
        .catch((error) => ({ error }))
        .finally(() => {
          this.calls.delete(callId)
        })
    } else {
      return await call.promise.finally(() => {
        this.calls.delete(callId)
      })
    }
  }

  protected async onConnect() {
    this.emit('connected')
  }

  protected async onDisconnect(reason: 'client' | 'server' | (string & {})) {
    this.emit('disconnected', reason)
  }

  protected async onMessage(buffer: ArrayBufferView) {
    if (!this.#messageContext) return
    const message = this.#protocol.decodeMessage(this.#messageContext, buffer)
    // console.dir(message)
    switch (message.type) {
      case ServerMessageType.RpcResponse:
        this.#handleRPCResponseMessage(message)
        break
      case ServerMessageType.RpcStreamResponse:
        this.#handleRPCStreamResponseMessage(message)
        break
      case ServerMessageType.RpcStreamChunk:
        this.#rpcStreams.push(message.callId, message.chunk)
        break
      case ServerMessageType.RpcStreamEnd:
        this.#rpcStreams.end(message.callId)
        break
      case ServerMessageType.RpcStreamAbort:
        this.#rpcStreams.abort(message.callId)
        break
      case ServerMessageType.ServerStreamPush:
        this.#serverStreams.push(message.streamId, message.chunk)
        break
      case ServerMessageType.ServerStreamEnd:
        this.#serverStreams.end(message.streamId)
        break
      case ServerMessageType.ServerStreamAbort:
        this.#serverStreams.abort(message.streamId)
        break
      case ServerMessageType.ClientStreamPull:
        this.#clientStreams.pull(message.streamId, message.size).then(
          (chunk) => {
            if (chunk) {
              const buffer = this.#protocol.encodeMessage(
                this.#messageContext!,
                ClientMessageType.ClientStreamPush,
                { streamId: message.streamId, chunk },
              )
              this.#send(buffer).catch(noopFn)
            } else {
              const buffer = this.#protocol.encodeMessage(
                this.#messageContext!,
                ClientMessageType.ClientStreamEnd,
                { streamId: message.streamId },
              )
              this.#send(buffer).catch(noopFn)
              this.#clientStreams.end(message.streamId)
            }
          },
          () => {
            const buffer = this.#protocol.encodeMessage(
              this.#messageContext!,
              ClientMessageType.ClientStreamAbort,
              { streamId: message.streamId },
            )
            this.#send(buffer).catch(noopFn)
          },
        )
        break
      case ServerMessageType.ClientStreamAbort:
        this.#clientStreams.abort(message.streamId)
        break
    }
  }

  #handleRPCResponseMessage(
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

  #handleRPCStreamResponseMessage(
    message: ServerMessageTypePayload[ServerMessageType.RpcStreamResponse],
  ) {
    const call = this.calls.get(message.callId)
    if (!call) throw new Error('Call not found for stream transformation')
    if (message.error) {
      call.reject(
        new ProtocolError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      )
    } else {
      const { procedure } = call
      const stream = new ProtocolServerStream({
        transform: (chunk) => {
          return this.transformer.decode(
            procedure,
            this.options.format.decode(chunk),
          )
        },
      })
      this.#rpcStreams.add(message.callId, stream)
      call.resolve(stream)
    }
  }

  #handleCallResponse(callId: number, response: ClientCallResponse) {
    const call = this.calls.get(callId)
    if (!call) return

    if (response.type === 'rpc_stream') {
      const stream = new ProtocolServerStream({
        transform: (chunk) => {
          return this.transformer.decode(
            call.procedure,
            this.options.format.decode(chunk),
          )
        },
      })
      call.resolve(stream)
      response.stream.pipeTo(stream.writable).catch(noopFn)
    } else if (response.type === 'blob') {
      const { metadata, source } = response
      const stream = new ProtocolServerBlobStream(metadata)
      call.resolve(stream)
      source.pipeTo(stream.writable).catch(noopFn)
    } else if (response.type === 'rpc') {
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

  #send(buffer: ArrayBufferView, signal?: AbortSignal) {
    if (this.#transport.type === ConnectionType.Unidirectional)
      throw new Error('Invalid transport type for send')
    return this.#transport.send(buffer, { signal })
  }

  #getStreamId() {
    if (this.#streamId >= MAX_UINT32) {
      this.#streamId = 0
    }
    return this.#streamId++
  }

  #getCallId() {
    if (this.#callId >= MAX_UINT32) {
      this.#callId = 0
    }
    return this.#callId++
  }
}
