import type { InteractivePromise, OneOf } from '@nmtjs/common'
import { createPromise } from '@nmtjs/common'

import type { ProtocolBlobMetadata } from '../common/blob.ts'
import type { BaseProtocolError, ProtocolRPCResponse } from '../common/types.ts'
import type { BaseClientFormat } from './format.ts'
import { concat, decodeNumber, encodeNumber } from '../common/binary.ts'
import {
  ClientMessageType,
  ErrorCode,
  ServerMessageType,
} from '../common/enums.ts'
import { EventEmitter } from './events.ts'
import {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
  ProtocolServerStream,
} from './stream.ts'

export class ProtocolError extends Error implements BaseProtocolError {
  code: string
  data?: any

  constructor(code: string, message?: string, data?: any) {
    super(message)
    this.code = code
    this.data = data
  }

  get message() {
    return `${this.code} ${super.message}`
  }

  toString() {
    return `${this.code} ${this.message}`
  }

  toJSON() {
    return { code: this.code, message: this.message, data: this.data }
  }
}

export class ProtocolClientStreams {
  readonly #collection = new Map<number, ProtocolClientBlobStream>()

  get(streamId: number) {
    const stream = this.#collection.get(streamId)
    if (!stream) throw new Error('Stream not found')
    return stream
  }

  add(
    source: ReadableStream,
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) {
    const stream = new ProtocolClientBlobStream(source, streamId, metadata)
    this.#collection.set(streamId, stream)
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
  }

  abort(streamId: number, error?: Error) {
    const stream = this.get(streamId)
    stream.abort(error)
    this.remove(streamId)
  }

  pull(streamId: number, size: number) {
    const stream = this.get(streamId)
    return stream.read(size)
  }

  end(streamId: number) {
    this.get(streamId).end()
    this.remove(streamId)
  }

  clear(error?: Error) {
    if (error) {
      for (const stream of this.#collection.values()) {
        stream.abort(error)
      }
    }
    this.#collection.clear()
  }
}

export class ProtocolServerStreams<
  T extends ProtocolServerStream = ProtocolServerStream,
> {
  readonly #collection = new Map<number, T>()

  has(streamId: number) {
    return this.#collection.has(streamId)
  }

  get(streamId: number) {
    const stream = this.#collection.get(streamId)
    if (!stream) throw new Error('Stream not found')
    return stream
  }

  add(streamId: number, stream: T) {
    this.#collection.set(streamId, stream)
    return stream
  }

  remove(streamId: number) {
    this.#collection.delete(streamId)
  }

  abort(streamId: number) {
    if (this.has(streamId)) {
      const stream = this.get(streamId)
      stream.abort()
      this.remove(streamId)
    }
  }

  async push(streamId: number, chunk: ArrayBuffer) {
    const stream = this.get(streamId)
    return await stream.push(chunk)
  }

  end(streamId: number) {
    const stream = this.get(streamId)
    stream.end()
    this.remove(streamId)
  }

  clear(error?: Error) {
    if (error) {
      for (const stream of this.#collection.values()) {
        stream.abort(error)
      }
    }
    this.#collection.clear()
  }
}

export type ProtocolTransportEventMap = {
  connected: []
  disconnected: [reason: 'server' | 'client' | 'error']
}

export interface ProtocolSendMetadata {
  callId?: number
  streamId?: number
}

export enum ProtocolTransportStatus {
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
}

export abstract class ProtocolTransport extends EventEmitter<ProtocolTransportEventMap> {
  status: ProtocolTransportStatus = ProtocolTransportStatus.DISCONNECTED

  abstract connect(
    auth: any,
    transformer: ProtocolBaseTransformer,
  ): Promise<void>
  abstract disconnect(): Promise<void>
  abstract call(
    procedure: string,
    payload: any,
    options: ProtocolBaseClientCallOptions,
    transformer: ProtocolBaseTransformer,
  ): Promise<ProtocolClientCall>
  abstract send(
    messageType: ClientMessageType,
    buffer: ArrayBuffer,
    metadata: ProtocolSendMetadata,
  ): Promise<void>
}

export class ProtocolBaseTransformer {
  encodeRPC(_procedure: string, payload: any) {
    return payload
  }
  decodeRPC(_procedure: string, payload: any) {
    return payload
  }
  decodeRPCChunk(_procedure: string, payload: any) {
    return payload
  }
  decodeEvent(_event: string, payload: any) {
    return payload
  }
}

export type ProtocolClientCall = InteractivePromise<any> & {
  procedure: string
  signal: AbortSignal
}

export type ProtocolBaseClientOptions = {
  transport: ProtocolTransport
  format: BaseClientFormat
  transformer?: ProtocolBaseTransformer
  timeout?: number
}

export type ProtocolBaseClientCallOptions = {
  signal?: AbortSignal
  timeout: number
}

export class BaseProtocol<
  T extends Record<string, Record<string, any>> = Record<
    string,
    Record<string, any>
  >,
> extends EventEmitter<
  {
    [N in keyof T]: {
      [E in keyof T[N] as `${Extract<N, string>}/${Extract<E, string>}`]: [
        payload: T[N][E],
      ]
    }
  }[keyof T]
> {
  protected readonly clientStreams: ProtocolClientStreams =
    new ProtocolClientStreams()
  protected readonly serverStreams: ProtocolServerStreams<ProtocolServerBlobStream> =
    new ProtocolServerStreams()
  protected readonly rpcStreams: ProtocolServerStreams =
    new ProtocolServerStreams()
  protected readonly calls = new Map<number, ProtocolClientCall>()
  protected callId = 0
  protected streamId = 0

  constructor(public readonly format: BaseClientFormat) {
    super()
  }

  get contentType() {
    return this.format.contentType
  }

  handleCallResponse(
    callId: number,
    call: ProtocolClientCall,
    response: OneOf<
      [{ error: BaseProtocolError }, { result: any; stream?: any }]
    >,
    transformer: ProtocolBaseTransformer,
  ) {
    if (response.error) {
      call.reject(
        new ProtocolError(
          response.error.code,
          response.error.message,
          response.error.data,
        ),
      )
    } else {
      try {
        const transformed = transformer.decodeRPC(
          call.procedure,
          response.result,
        )
        if (response.stream)
          call.resolve({ result: transformed, stream: response.stream })
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

  handleRpcResponse(
    { callId, error, result, streams }: ProtocolRPCResponse,
    transformer: ProtocolBaseTransformer,
    stream?: ProtocolServerStream,
  ) {
    const call = this.calls.get(callId)
    if (!call) throw new Error('Call not found')
    for (const key in streams) {
      const stream = streams[key]
      this.serverStreams.add(stream.id, stream)
    }
    this.handleCallResponse(
      callId,
      call,
      error ? { error } : { result, stream },
      transformer,
    )
    return call
  }

  handleRpcStreamResponse(
    response: ProtocolRPCResponse,
    stream: ProtocolServerStream,
    transformer: ProtocolBaseTransformer,
  ) {
    const call = this.handleRpcResponse(response, transformer, stream)
    this.rpcStreams.add(response.callId, stream)
    return call
  }

  createCall(procedure: string, options: ProtocolBaseClientCallOptions) {
    const timeoutSignal = AbortSignal.timeout(options.timeout)
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal

    const call = Object.assign(createPromise(), { procedure, signal })

    timeoutSignal.addEventListener(
      'abort',
      () => {
        const error = new ProtocolError(
          ErrorCode.RequestTimeout,
          'Request timeout',
        )
        call.reject(error)
      },
      { once: true },
    )

    return call
  }

  createRpc(
    procedure: string,
    payload: any,
    options: ProtocolBaseClientCallOptions,
    transformer: ProtocolBaseTransformer,
  ) {
    const callId = ++this.callId
    const call = this.createCall(procedure, options)
    const { buffer, streams } = this.format.encodeRPC(
      { callId, procedure, payload: transformer.encodeRPC(procedure, payload) },
      {
        addStream: (blob) => {
          const streamId = ++this.streamId
          return this.clientStreams.add(blob.source, streamId, blob.metadata)
        },
        getStream: (id) => {
          const stream = this.clientStreams.get(id)
          return stream
        },
      },
    )

    this.calls.set(callId, call)

    return { callId, call, streams, buffer }
  }

  pushRpcStream(callId: number, chunk: any) {
    this.rpcStreams.push(callId, chunk)
  }

  endRpcStream(callId: number) {
    this.rpcStreams.end(callId)
  }

  abortRpcStream(callId: number) {
    this.rpcStreams.abort(callId)
  }

  removeClientStream(streamId: number) {
    this.clientStreams.remove(streamId)
  }

  pullClientStream(streamId: number, size: number) {
    return this.clientStreams.pull(streamId, size)
  }

  endClientStream(streamId: number) {
    this.clientStreams.end(streamId)
  }

  abortClientStream(streamId: number, error?: Error) {
    this.clientStreams.abort(streamId, error)
  }

  addServerStream(stream: ProtocolServerBlobStream) {
    this.serverStreams.add(stream.id, stream)
  }

  removeServerStream(streamId: number) {
    this.serverStreams.remove(streamId)
  }

  pushServerStream(streamId: number, chunk: ArrayBuffer) {
    return this.serverStreams.push(streamId, chunk)
  }

  endServerStream(streamId: number) {
    this.serverStreams.end(streamId)
  }

  abortServerStream(streamId: number, _error?: Error) {
    this.serverStreams.abort(streamId)
  }

  emitEvent(
    event: string,
    payload: string,
    transformer: ProtocolBaseTransformer,
  ) {
    const transformed = transformer.decodeEvent(event, payload)
    this.emit(
      event,
      //@ts-expect-error
      transformed,
    )
  }
}

export class Protocol<
  T extends Record<string, Record<string, any>> = Record<
    string,
    Record<string, any>
  >,
> extends BaseProtocol<T> {
  handleServerMessage(
    buffer: ArrayBuffer,
    transport: ProtocolTransport,
    transformer: ProtocolBaseTransformer,
  ) {
    const type = decodeNumber(buffer, 'Uint8')
    const messageBuffer = buffer.slice(Uint8Array.BYTES_PER_ELEMENT)
    if (type in ServerMessageType) {
      const messageType = type as ServerMessageType
      if (typeof ServerMessageType[messageType] !== 'undefined') {
        this[messageType](messageBuffer, transport, transformer)
      } else {
        throw new Error(`Unknown message type: ${messageType}`)
      }
    }
  }

  protected [ServerMessageType.Event](
    buffer: ArrayBuffer,
    _transport: ProtocolTransport,
    transformer: ProtocolBaseTransformer,
  ) {
    const [event, payload] = this.format.decode(buffer)
    this.emitEvent(event, payload, transformer)
  }

  protected [ServerMessageType.RpcResponse](
    buffer: ArrayBuffer,
    transport: ProtocolTransport,
    transformer: ProtocolBaseTransformer,
  ) {
    const response = this.format.decodeRPC(buffer, {
      addStream: (id, callId, metadata) => {
        return new ProtocolServerBlobStream(id, metadata, {
          start: () => {
            transport.send(
              ClientMessageType.ServerStreamPull,
              encodeNumber(id, 'Uint32'),
              { callId, streamId: id },
            )
          },
        })
      },
      getStream: (id) => {
        return this.serverStreams.get(id)
      },
    })
    this.handleRpcResponse(response, transformer)
  }

  protected [ServerMessageType.RpcStreamResponse](
    buffer: ArrayBuffer,
    transport: ProtocolTransport,
    transformer: ProtocolBaseTransformer,
  ) {
    const response = this.format.decodeRPC(buffer, {
      addStream: (id, callId, metadata) => {
        return new ProtocolServerBlobStream(id, metadata, {
          start: () => {
            transport.send(
              ClientMessageType.ServerStreamPull,
              encodeNumber(id, 'Uint32'),
              { callId, streamId: id },
            )
          },
        })
      },
      getStream: (id) => {
        return this.serverStreams.get(id)
      },
    })

    const stream = new ProtocolServerStream({
      transform: (chunk, controller) => {
        const transformed = transformer.decodeRPCChunk(call.procedure, chunk)
        controller.enqueue(transformed)
      },
    })

    const call = this.handleRpcStreamResponse(response, stream, transformer)
  }

  protected [ServerMessageType.RpcStreamChunk](
    buffer: ArrayBuffer,
    _transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const callId = decodeNumber(buffer, 'Uint32')
    const chunk = buffer.slice(Uint32Array.BYTES_PER_ELEMENT)
    const payload = this.format.decode(chunk)
    this.pushRpcStream(callId, payload)
  }

  protected [ServerMessageType.RpcStreamEnd](
    buffer: ArrayBuffer,
    _transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const callId = decodeNumber(buffer, 'Uint32')
    this.endRpcStream(callId)
  }

  protected [ServerMessageType.RpcStreamAbort](
    buffer: ArrayBuffer,
    _transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const callId = decodeNumber(buffer, 'Uint32')
    this.abortRpcStream(callId)
  }

  protected [ServerMessageType.ServerStreamPush](
    buffer: ArrayBuffer,
    transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const chunk = buffer.slice(Uint32Array.BYTES_PER_ELEMENT)
    this.pushServerStream(streamId, chunk)
    transport.send(
      ClientMessageType.ServerStreamPull,
      encodeNumber(streamId, 'Uint32'),
      { streamId },
    )
  }

  protected [ServerMessageType.ServerStreamEnd](
    buffer: ArrayBuffer,
    _transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.endServerStream(streamId)
  }

  protected [ServerMessageType.ServerStreamAbort](
    buffer: ArrayBuffer,
    _transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.abortServerStream(streamId)
  }

  protected [ServerMessageType.ClientStreamPull](
    buffer: ArrayBuffer,
    transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    const size = decodeNumber(buffer, 'Uint32', Uint32Array.BYTES_PER_ELEMENT)
    this.pullClientStream(streamId, size).then(
      (chunk) => {
        if (chunk) {
          transport.send(
            ClientMessageType.ClientStreamPush,
            concat(encodeNumber(streamId, 'Uint32'), chunk),
            { streamId },
          )
        } else {
          transport.send(
            ClientMessageType.ClientStreamEnd,
            encodeNumber(streamId, 'Uint32'),
            { streamId },
          )
          this.endClientStream(streamId)
        }
      },
      () => {
        transport.send(
          ClientMessageType.ClientStreamAbort,
          encodeNumber(streamId, 'Uint32'),
          { streamId },
        )
      },
    )
  }

  protected [ServerMessageType.ClientStreamAbort](
    buffer: ArrayBuffer,
    _transport: ProtocolTransport,
    _transformer: ProtocolBaseTransformer,
  ) {
    const streamId = decodeNumber(buffer, 'Uint32')
    this.abortClientStream(streamId)
  }
}
