import type { Future, TypeProvider } from '@nmtjs/common'
import type { TAnyRouterContract } from '@nmtjs/contract'
import type { BaseProtocolError, ProtocolVersion } from '@nmtjs/protocol'
import type {
  BaseClientFormat,
  MessageContext,
  ProtocolVersionInterface,
} from '@nmtjs/protocol/client'
import { createPromise, MAX_UINT32, noopFn } from '@nmtjs/common'
import {
  ClientMessageType,
  ConnectionType,
  ErrorCode,
  ServerMessageType,
} from '@nmtjs/protocol'
import {
  ClientStreams,
  ProtocolError,
  ProtocolServerStream,
  ServerStreams,
  versions,
} from '@nmtjs/protocol/client'

import type { BaseClientTransformer } from './transformers.ts'
import type { ClientTransport, ClientTransportInstance } from './transport.ts'
import type { ClientCallers, ResolveAPIRouterRoutes } from './types.ts'
import { EventEmitter } from './events.ts'

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
  Transport extends ClientTransport<any, any> = ClientTransport<any, any>,
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
  Routes extends {
    contract: RouterContract
    routes: ResolveAPIRouterRoutes<
      RouterContract,
      InputTypeProvider,
      OutputTypeProvider
    >
  } = {
    contract: RouterContract
    routes: ResolveAPIRouterRoutes<
      RouterContract,
      InputTypeProvider,
      OutputTypeProvider
    >
  },
> extends EventEmitter<{
  connected: []
  disconnected: [reason: 'server' | 'client' | (string & {})]
}> {
  _!: { routes: Routes; safe: SafeCall }

  protected abstract transformer: BaseClientTransformer

  protected readonly calls = new Map<number, ProtocolClientCall>()

  #callers!: ClientCallers<Routes, SafeCall>
  #transportInstance!: ClientTransportInstance

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
    readonly transport: Transport,
    readonly transportOptions: Transport extends ClientTransport<any, infer U>
      ? U
      : never,
  ) {
    super()
    this.#protocol = versions[options.protocol]

    const createProxy = (parts: string[] = []) =>
      new Proxy(() => {}, {
        get: (_, prop) => createProxy([...parts, prop as string]),
        apply: (_, __, args) => {
          const procedure = parts.join('/')
          const [payload, options] = args
          const signal = options?.signal
          return this._call(procedure, payload, signal)
        },
      })
    this.#callers = createProxy() as any

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

  protected async _call(procedure: string, payload: any, signal?: AbortSignal) {
    const callId = ++this.#callId
    const call = createPromise() as ProtocolClientCall
    call.procedure = procedure
    call.signal = signal
    this.calls.set(callId, call)

    if (this.options.timeout) {
      const timeout = setTimeout(() => {
        call.reject(
          new ProtocolError(ErrorCode.RequestTimeout, 'Request timeout'),
        )
      }, this.options.timeout)
      call.promise.finally(() => clearTimeout(timeout))
    }

    if (signal) {
      if (signal.aborted) {
        call.reject(new ProtocolError(ErrorCode.ClientRequestError, 'Aborted'))
      } else {
        signal.addEventListener(
          'abort',
          () => {
            call.reject(
              new ProtocolError(ErrorCode.ClientRequestError, 'Aborted'),
            )
            if (
              this.transport.type === ConnectionType.Bidirectional &&
              this.#messageContext
            ) {
              const buffer = this.#protocol.encodeMessage(
                this.#messageContext,
                ClientMessageType.RpcAbort,
                { callId },
              )
              this.#send(buffer).catch(noopFn)
            }
          },
          { once: true },
        )
      }
    }

    try {
      if (this.transport.type === ConnectionType.Bidirectional) {
        if (!this.#messageContext) throw new Error('Not connected')

        const encodedPayload = this.transformer.encode(procedure, payload)
        const buffer = this.#protocol.encodeMessage(
          this.#messageContext,
          ClientMessageType.Rpc,
          { callId, procedure, payload: encodedPayload },
        )

        await this.#send(
          buffer,
          signal || AbortSignal.timeout(this.options.timeout || 10000),
        )
      } else {
        const instance = this
          .#transportInstance as ClientTransportInstance<ConnectionType.Unidirectional>
        const encodedPayload = this.transformer.encode(procedure, payload)
        const response = await instance.call(
          {
            format: this.options.format,
            application: this.options.application,
            auth: this.auth,
          },
          { callId, procedure, payload: encodedPayload },
          signal || AbortSignal.timeout(this.options.timeout || 10000),
        )
        this.#handleRpcResponse(callId, false, response as any)
      }
    } catch (error) {
      call.reject(error)
      this.calls.delete(callId)
    }

    if (this.options.safe) {
      return await call.promise
        .then((result) => ({ result }))
        .catch((error) => ({ error }))
    } else {
      return await call.promise
    }
  }

  get call() {
    return this.#callers
  }

  setAuth(auth: any) {
    this.auth = auth
  }

  async connect() {
    const { format, protocol } = this.options
    const instance = (await this.transport.factory(
      { protocol, format },
      this.transportOptions,
    )) as ClientTransportInstance<ConnectionType.Bidirectional>

    this.#transportInstance = instance

    if (this.transport.type === ConnectionType.Bidirectional) {
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
      return instance.connect({
        auth: this.auth,
        application: this.options.application,
        onMessage: this.onMessage.bind(this),
        onConnect: this.onConnect.bind(this),
        onDisconnect: this.onDisconnect.bind(this),
      })
    }
  }

  disconnect() {
    if (this.transport.type === ConnectionType.Bidirectional) {
      const instance = this
        .#transportInstance as ClientTransportInstance<ConnectionType.Bidirectional>
      return instance.disconnect()
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
        this.#handleRpcResponse(message.callId, !!message.error, {
          result: message.error || message.result,
        })
        break
      case ServerMessageType.RpcStreamResponse: {
        if (message.error) {
          this.#handleRpcStreamResponse(message.callId, message.error)
        } else {
          const stream = new ProtocolServerStream({
            transform: (chunk, controller) => {
              const call = this.calls.get(message.callId)
              if (call) {
                const transformed = this.transformer.decode(
                  call.procedure,
                  this.options.format.decode(chunk),
                )
                controller.enqueue(transformed)
              }
            },
          })
          this.#rpcStreams.add(message.callId, stream)
          this.#handleRpcStreamResponse(message.callId, undefined, stream)
        }
        break
      }
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

  #handleRpcStreamResponse(
    callId: number,
    error: BaseProtocolError | undefined,
    stream?: ProtocolServerStream,
  ) {
    const call = this.calls.get(callId)
    if (!call) return
    if (error) {
      call.reject(new ProtocolError(error.code, error.message, error.data))
    } else {
      call.resolve(stream)
    }
  }

  #handleRpcResponse(
    callId: number,
    error: boolean,
    response: { result: any; streams?: any },
    stream?: ProtocolServerStream,
  ) {
    const call = this.calls.get(callId)
    if (!call) return

    if (error) {
      call.reject(
        new ProtocolError(
          response.result.code,
          response.result.message,
          response.result.data,
        ),
      )
    } else {
      try {
        const transformed = this.transformer.decode(
          call.procedure,
          response.result,
        )
        if (stream) call.resolve(stream)
        else call.resolve(transformed)
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
    this.calls.delete(callId)
  }

  #send(buffer: ArrayBufferView, signal?: AbortSignal) {
    if (this.transport.type === ConnectionType.Unidirectional)
      throw new Error('Invalid transport type for send')
    const instance = this
      .#transportInstance as ClientTransportInstance<ConnectionType.Bidirectional>
    return instance.send(buffer, signal ?? AbortSignal.timeout(1000))
  }

  #getStreamId() {
    if (this.#streamId >= MAX_UINT32) {
      this.#streamId = 1
    }
    return this.#streamId++
  }
}

// import type { TAnyRouterContract } from "@nmtjs/contract";
// import type { BaseClientFormat } from "./format.ts";
// import type { ProtocolVersionInterface } from "./versions/v1.ts";
// import type { ClientMessageType } from "../common/enums.ts";

// import type { ProtocolBlobMetadata } from '../common/blob.ts'
// import type { BaseProtocolError, ProtocolRPCResponse } from '../common/types.ts'
// import type { BaseClientFormat } from './format.ts'
// import { concat, decodeNumber, encodeNumber } from '../common/binary.ts'
// import {
//   ClientMessageType,
//   ErrorCode,
//   ServerMessageType,
// } from '../common/enums.ts'
// import { EventEmitter } from './events.ts'
// import {
//   ProtocolClientBlobStream,
//   ProtocolServerBlobStream,
//   ProtocolServerStream,
// } from './stream.ts'

// export class ProtocolError extends Error implements BaseProtocolError {
//   code: string
//   data?: any

//   constructor(code: string, message?: string, data?: any) {
//     super(message)
//     this.code = code
//     this.data = data
//   }

//   get message() {
//     return `${this.code} ${super.message}`
//   }

//   toString() {
//     return `${this.code} ${this.message}`
//   }

//   toJSON() {
//     return { code: this.code, message: this.message, data: this.data }
//   }
// }

// export type ProtocolTransportEventMap = {
//   connected: []
//   disconnected: [reason: 'server' | 'client' | 'error']
// }

// export interface ProtocolSendMetadata {
//   callId?: number
//   streamId?: number
// }

// export enum ProtocolTransportStatus {
//   CONNECTED = 'CONNECTED',
//   DISCONNECTED = 'DISCONNECTED',
//   CONNECTING = 'CONNECTING',
// }

// export abstract class ProtocolTransport<
//   Options = unknown,
// > extends EventEmitter<ProtocolTransportEventMap> {
//   status: ProtocolTransportStatus = ProtocolTransportStatus.DISCONNECTED

//   constructor(protected options?: Options) {
//     super()
//   }

//   abstract connect(
//     auth: any,
//     transformer: ProtocolBaseTransformer,
//   ): Promise<void>
//   abstract disconnect(): Promise<void>
//   abstract call(
//     procedure: string,
//     payload: any,
//     options: ProtocolBaseClientCallOptions,
//     transformer: ProtocolBaseTransformer,
//   ): Promise<ProtocolClientCall>
//   abstract send(
//     messageType: ClientMessageType,
//     buffer: ArrayBuffer,
//     metadata: ProtocolSendMetadata,
//   ): Promise<void>
// }

// export class ProtocolBaseTransformer {
//   encodeRPC(_procedure: string, payload: any) {
//     return payload
//   }
//   decodeRPC(_procedure: string, payload: any) {
//     return payload
//   }
//   decodeRPCChunk(_procedure: string, payload: any) {
//     return payload
//   }
//   decodeEvent(_event: string, payload: any) {
//     return payload
//   }
// }

// export type ProtocolClientCall = InteractivePromise<any> & {
//   procedure: string
//   signal: AbortSignal
// }

// export type ProtocolBaseClientOptions = {
//   transport: ProtocolTransport
//   format: BaseClientFormat
//   transformer?: ProtocolBaseTransformer
//   timeout?: number
// }

// export type ProtocolBaseClientCallOptions = {
//   signal?: AbortSignal
//   timeout: number
// }

// export class BaseProtocol<
//   T extends Record<string, Record<string, any>> = Record<
//     string,
//     Record<string, any>
//   >,
// > extends EventEmitter<
//   {
//     [N in keyof T]: {
//       [E in keyof T[N] as `${Extract<N, string>}/${Extract<E, string>}`]: [
//         payload: T[N][E],
//       ]
//     }
//   }[keyof T]
// > {
//   protected readonly clientStreams: ProtocolClientStreams =
//     new ProtocolClientStreams()
//   protected readonly serverStreams: ProtocolServerStreams<ProtocolServerBlobStream> =
//     new ProtocolServerStreams()
//   protected readonly rpcStreams: ProtocolServerStreams =
//     new ProtocolServerStreams()
//   protected readonly calls = new Map<number, ProtocolClientCall>()
//   protected callId = 0
//   protected streamId = 0

//   constructor(public readonly format: BaseClientFormat) {
//     super()
//   }

//   get contentType() {
//     return this.format.contentType
//   }

//   handleCallResponse(
//     callId: number,
//     call: ProtocolClientCall,
//     error: boolean,
//     response: { result: any; stream?: any },
//     transformer: ProtocolBaseTransformer,
//   ) {
//     if (error) {
//       call.reject(
//         new ProtocolError(
//           response.result.code,
//           response.result.message,
//           response.result.data,
//         ),
//       )
//     } else {
//       try {
//         const transformed = transformer.decodeRPC(
//           call.procedure,
//           response.result,
//         )
//         if (response.stream)
//           call.resolve({ result: transformed, stream: response.stream })
//         else call.resolve(transformed)
//       } catch (error) {
//         call.reject(
//           new ProtocolError(
//             ErrorCode.ClientRequestError,
//             'Unable to decode response',
//             error,
//           ),
//         )
//       }
//     }
//     this.calls.delete(callId)
//   }

//   handleRpcResponse(
//     callId: number,
//     error: boolean,
//     { result, streams }: ProtocolRPCResponse,
//     transformer: ProtocolBaseTransformer,
//     stream?: ProtocolServerStream,
//   ) {
//     const call = this.calls.get(callId)
//     if (!call) throw new Error('Call not found')
//     for (const key in streams) {
//       const stream = streams[key]
//       this.serverStreams.add(stream.id, stream)
//     }
//     this.handleCallResponse(
//       callId,
//       call,
//       error,
//       { result, stream },
//       transformer,
//     )
//     return call
//   }

//   handleRpcStreamResponse(
//     callId: number,
//     response: ProtocolRPCResponse,
//     stream: ProtocolServerStream,
//     transformer: ProtocolBaseTransformer,
//   ) {
//     const call = this.handleRpcResponse(
//       callId,
//       false,
//       response,
//       transformer,
//       stream,
//     )
//     this.rpcStreams.add(callId, stream)
//     return call
//   }

//   createCall(procedure: string, options: ProtocolBaseClientCallOptions) {
//     const timeoutSignal = AbortSignal.timeout(options.timeout)
//     const signal = options.signal
//       ? AbortSignal.any([options.signal, timeoutSignal])
//       : timeoutSignal

//     const call = Object.assign(createPromise(), { procedure, signal })

//     timeoutSignal.addEventListener(
//       'abort',
//       () => {
//         const error = new ProtocolError(
//           ErrorCode.RequestTimeout,
//           'Request timeout',
//         )
//         call.reject(error)
//       },
//       { once: true },
//     )

//     return call
//   }

//   createRpc(
//     procedure: string,
//     payload: any,
//     options: ProtocolBaseClientCallOptions,
//     transformer: ProtocolBaseTransformer,
//   ) {
//     const callId = ++this.callId
//     const call = this.createCall(procedure, options)
//     const { buffer, streams } = this.format.encodeRPC(
//       { callId, procedure, payload: transformer.encodeRPC(procedure, payload) },
//       {
//         addStream: (blob) => {
//           const streamId = ++this.streamId
//           return this.clientStreams.add(blob.source, streamId, blob.metadata)
//         },
//         getStream: (id) => {
//           const stream = this.clientStreams.get(id)
//           return stream
//         },
//       },
//     )

//     this.calls.set(callId, call)

//     return { callId, call, streams, buffer }
//   }

//   pushRpcStream(callId: number, chunk: any) {
//     this.rpcStreams.push(callId, chunk)
//   }

//   endRpcStream(callId: number) {
//     this.rpcStreams.end(callId)
//   }

//   abortRpcStream(callId: number) {
//     this.rpcStreams.abort(callId)
//   }

//   removeClientStream(streamId: number) {
//     this.clientStreams.remove(streamId)
//   }

//   pullClientStream(streamId: number, size: number) {
//     return this.clientStreams.pull(streamId, size)
//   }

//   endClientStream(streamId: number) {
//     this.clientStreams.end(streamId)
//   }

//   abortClientStream(streamId: number, error?: Error) {
//     this.clientStreams.abort(streamId, error)
//   }

//   addServerStream(stream: ProtocolServerBlobStream) {
//     this.serverStreams.add(stream.id, stream)
//   }

//   removeServerStream(streamId: number) {
//     this.serverStreams.remove(streamId)
//   }

//   pushServerStream(streamId: number, chunk: ArrayBuffer) {
//     return this.serverStreams.push(streamId, chunk)
//   }

//   endServerStream(streamId: number) {
//     this.serverStreams.end(streamId)
//   }

//   abortServerStream(streamId: number, _error?: Error) {
//     this.serverStreams.abort(streamId)
//   }

//   emitEvent(
//     event: string,
//     payload: string,
//     transformer: ProtocolBaseTransformer,
//   ) {
//     const transformed = transformer.decodeEvent(event, payload)
//     this.emit(
//       event,
//       //@ts-expect-error
//       transformed,
//     )
//   }
// }

// export class Protocol<
//   T extends Record<string, Record<string, any>> = Record<
//     string,
//     Record<string, any>
//   >,
// > extends BaseProtocol<T> {
//   handleServerMessage(
//     buffer: ArrayBuffer,
//     transport: ProtocolTransport,
//     transformer: ProtocolBaseTransformer,
//   ) {
//     const type = decodeNumber(buffer, 'Uint8')
//     const messageBuffer = buffer.slice(Uint8Array.BYTES_PER_ELEMENT)
//     if (type in ServerMessageType) {
//       const messageType = type as ServerMessageType
//       if (typeof ServerMessageType[messageType] !== 'undefined') {
//         this[messageType](messageBuffer, transport, transformer)
//       } else {
//         throw new Error(`Unknown message type: ${messageType}`)
//       }
//     }
//   }

//   protected [ServerMessageType.Event](
//     buffer: ArrayBuffer,
//     _transport: ProtocolTransport,
//     transformer: ProtocolBaseTransformer,
//   ) {
//     const [event, payload] = this.format.decode(buffer) as [string, any]
//     this.emitEvent(event, payload, transformer)
//   }

//   protected [ServerMessageType.RpcResponse](
//     buffer: ArrayBuffer,
//     transport: ProtocolTransport,
//     transformer: ProtocolBaseTransformer,
//   ) {
//     const response = this.format.decodeRPC(buffer, {
//       addStream: (id, metadata) => {
//         return new ProtocolServerBlobStream(id, metadata, {
//           start: () => {
//             transport.send(
//               ClientMessageType.ServerStreamPull,
//               encodeNumber(id, 'Uint32'),
//               { streamId: id },
//             )
//           },
//         })
//       },
//       getStream: (id) => {
//         return this.serverStreams.get(id)
//       },
//     })
//     this.handleRpcResponse(response, transformer)
//   }

//   protected [ServerMessageType.RpcStreamResponse](
//     buffer: ArrayBuffer,
//     transport: ProtocolTransport,
//     transformer: ProtocolBaseTransformer,
//   ) {
//     const response = this.format.decodeRPC(buffer, {
//       addStream: (id, callId, metadata) => {
//         return new ProtocolServerBlobStream(id, metadata, {
//           start: () => {
//             transport.send(
//               ClientMessageType.ServerStreamPull,
//               encodeNumber(id, 'Uint32'),
//               { callId, streamId: id },
//             )
//           },
//         })
//       },
//       getStream: (id) => {
//         return this.serverStreams.get(id)
//       },
//     })

//     const stream = new ProtocolServerStream({
//       transform: (chunk, controller) => {
//         const transformed = transformer.decodeRPCChunk(call.procedure, chunk)
//         controller.enqueue(transformed)
//       },
//     })

//     const call = this.handleRpcStreamResponse(response, stream, transformer)
//   }

//   protected [ServerMessageType.RpcStreamChunk](
//     buffer: ArrayBuffer,
//     _transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const callId = decodeNumber(buffer, 'Uint32')
//     const chunk = buffer.slice(Uint32Array.BYTES_PER_ELEMENT)
//     const payload = this.format.decode(chunk)
//     this.pushRpcStream(callId, payload)
//   }

//   protected [ServerMessageType.RpcStreamEnd](
//     buffer: ArrayBuffer,
//     _transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const callId = decodeNumber(buffer, 'Uint32')
//     this.endRpcStream(callId)
//   }

//   protected [ServerMessageType.RpcStreamAbort](
//     buffer: ArrayBuffer,
//     _transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const callId = decodeNumber(buffer, 'Uint32')
//     this.abortRpcStream(callId)
//   }

//   protected [ServerMessageType.ServerStreamPush](
//     buffer: ArrayBuffer,
//     transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const streamId = decodeNumber(buffer, 'Uint32')
//     const chunk = buffer.slice(Uint32Array.BYTES_PER_ELEMENT)
//     this.pushServerStream(streamId, chunk)
//     transport.send(
//       ClientMessageType.ServerStreamPull,
//       encodeNumber(streamId, 'Uint32'),
//       { streamId },
//     )
//   }

//   protected [ServerMessageType.ServerStreamEnd](
//     buffer: ArrayBuffer,
//     _transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const streamId = decodeNumber(buffer, 'Uint32')
//     this.endServerStream(streamId)
//   }

//   protected [ServerMessageType.ServerStreamAbort](
//     buffer: ArrayBuffer,
//     _transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const streamId = decodeNumber(buffer, 'Uint32')
//     this.abortServerStream(streamId)
//   }

//   protected [ServerMessageType.ClientStreamPull](
//     buffer: ArrayBuffer,
//     transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const streamId = decodeNumber(buffer, 'Uint32')
//     const size = decodeNumber(buffer, 'Uint32', Uint32Array.BYTES_PER_ELEMENT)
//     this.pullClientStream(streamId, size).then(
//       (chunk) => {
//         if (chunk) {
//           transport.send(
//             ClientMessageType.ClientStreamPush,
//             concat(encodeNumber(streamId, 'Uint32'), chunk),
//             { streamId },
//           )
//         } else {
//           transport.send(
//             ClientMessageType.ClientStreamEnd,
//             encodeNumber(streamId, 'Uint32'),
//             { streamId },
//           )
//           this.endClientStream(streamId)
//         }
//       },
//       () => {
//         transport.send(
//           ClientMessageType.ClientStreamAbort,
//           encodeNumber(streamId, 'Uint32'),
//           { streamId },
//         )
//       },
//     )
//   }

//   protected [ServerMessageType.ClientStreamAbort](
//     buffer: ArrayBuffer,
//     _transport: ProtocolTransport,
//     _transformer: ProtocolBaseTransformer,
//   ) {
//     const streamId = decodeNumber(buffer, 'Uint32')
//     this.abortClientStream(streamId)
//   }
// }
