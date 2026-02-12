import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'
import type {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '../common/enums.ts'
import type { BaseProtocolError, EncodeRPCStreams } from '../common/types.ts'
import type { BaseClientDecoder, BaseClientEncoder } from './format.ts'
import type {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
} from './stream.ts'
import { concat } from '../common/binary.ts'

export type MessageContext = {
  decoder: BaseClientDecoder
  encoder: BaseClientEncoder
  addClientStream: (blob: ProtocolBlob) => ProtocolClientBlobStream
  addServerStream: (
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) => (options?: { signal?: AbortSignal }) => ProtocolServerBlobStream
  transport: { send: (buffer: ArrayBufferView) => void }
  streamId: () => number
}

export type ClientMessageTypePayload = {
  [ClientMessageType.Rpc]: { callId: number; procedure: string; payload: any }
  [ClientMessageType.RpcAbort]: { callId: number; reason?: string }
  [ClientMessageType.RpcPull]: { callId: number }
  [ClientMessageType.Ping]: { nonce: number }
  [ClientMessageType.Pong]: { nonce: number }
  [ClientMessageType.ClientStreamPush]: {
    streamId: number
    chunk: ArrayBufferView
  }
  [ClientMessageType.ClientStreamEnd]: { streamId: number }
  [ClientMessageType.ClientStreamAbort]: { streamId: number; reason?: string }
  [ClientMessageType.ServerStreamPull]: { streamId: number; size: number }
  [ClientMessageType.ServerStreamAbort]: { streamId: number; reason?: string }
}

export type ServerMessageTypePayload = {
  [ServerMessageType.RpcResponse]: {
    callId: number
    result?: any
    error?: BaseProtocolError
    streams?: EncodeRPCStreams
  }
  [ServerMessageType.RpcStreamResponse]: {
    callId: number
    error?: BaseProtocolError
  }
  [ServerMessageType.RpcStreamChunk]: { callId: number; chunk: ArrayBufferView }
  [ServerMessageType.RpcStreamEnd]: { callId: number }
  [ServerMessageType.RpcStreamAbort]: { callId: number; reason?: string }
  [ServerMessageType.Pong]: { nonce: number }
  [ServerMessageType.Ping]: { nonce: number }
  [ServerMessageType.ServerStreamAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ServerStreamEnd]: { streamId: number }
  [ServerMessageType.ServerStreamPush]: {
    streamId: number
    chunk: ArrayBufferView
  }
  [ServerMessageType.ClientStreamAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ClientStreamPull]: { streamId: number; size: number }
}

export abstract class ProtocolVersionInterface {
  abstract version: ProtocolVersion
  abstract decodeMessage(
    context: MessageContext,
    buffer: ArrayBufferView,
  ): {
    [K in keyof ServerMessageTypePayload]: {
      type: K
    } & ServerMessageTypePayload[K]
  }[keyof ServerMessageTypePayload]
  abstract encodeMessage<T extends ClientMessageType>(
    context: MessageContext,
    messageType: T,
    payload: ClientMessageTypePayload[T],
  ): any

  protected encode(...chunks: (ArrayBuffer | ArrayBufferView)[]) {
    return concat(...chunks)
  }
}

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
