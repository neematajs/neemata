import type {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '../common/enums.ts'
import type { BaseProtocolError, EncodeRPCStreams } from '../common/types.ts'
import type { MessageContext } from './types.ts'
import { concat } from '../common/binary.ts'

export class ProtocolError extends Error implements BaseProtocolError {
  code: string
  data?: any

  constructor(code: string, message?: string, data?: any) {
    super(message)
    this.code = code
    this.data = data
  }

  // code stays out of `message` so serialization round-trips don't
  // accumulate "CODE CODE message" prefixes
  toString() {
    return `${this.code} ${this.message}`
  }

  toJSON() {
    return {
      name: this.code,
      message: this.message,
      data: this.data,
      code: this.code,
    }
  }
}

export abstract class ProtocolVersionInterface {
  abstract version: ProtocolVersion
  abstract decodeMessage(
    context: MessageContext,
    buffer: ArrayBufferView,
  ): {
    [K in keyof ClientMessageTypePayload]: {
      type: K
    } & ClientMessageTypePayload[K]
  }[keyof ClientMessageTypePayload]
  abstract encodeMessage<T extends ServerMessageType = ServerMessageType>(
    context: MessageContext,
    messageType: T,
    payload: ServerMessageTypePayload[T],
  ): ArrayBufferView

  protected encode(
    ...chunks: (ArrayBuffer | ArrayBufferView)[]
  ): ArrayBufferView {
    return concat(...chunks)
  }
}

export type ServerMessageTypePayload = {
  // [ServerMessageType.Event]: { event: string; data: any }
  [ServerMessageType.RpcResponse]: {
    callId: number
    result: any
    streams: EncodeRPCStreams
    error: any | null
  }
  [ServerMessageType.RpcStreamAbort]: { callId: number; reason?: string }
  [ServerMessageType.RpcStreamEnd]: { callId: number }
  [ServerMessageType.RpcStreamChunk]: { callId: number; chunk: ArrayBufferView }
  [ServerMessageType.RpcStreamResponse]: { callId: number }
  [ServerMessageType.Pong]: { nonce: number }
  [ServerMessageType.Ping]: { nonce: number }
  [ServerMessageType.ClientBlobAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ClientBlobPull]: { streamId: number; size: number }
  [ServerMessageType.ServerBlobAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ServerBlobEnd]: { streamId: number }
  [ServerMessageType.ServerBlobPush]: {
    streamId: number
    chunk: ArrayBufferView
  }
}

export type ClientMessageTypePayload = {
  [ClientMessageType.Rpc]: {
    rpc: {
      callId: number
      procedure: string
      payload: unknown
      streams?: EncodeRPCStreams
    }
  }
  [ClientMessageType.RpcAbort]: { callId: number; reason?: string }
  [ClientMessageType.RpcStreamPull]: { callId: number; size: number }
  [ClientMessageType.Ping]: { nonce: number }
  [ClientMessageType.Pong]: { nonce: number }
  [ClientMessageType.ClientBlobPush]: {
    streamId: number
    chunk: ArrayBufferView
  }
  [ClientMessageType.ClientBlobEnd]: { streamId: number }
  [ClientMessageType.ClientBlobAbort]: { streamId: number; reason?: string }
  [ClientMessageType.ServerBlobPull]: { streamId: number; size: number }
  [ClientMessageType.ServerBlobAbort]: { streamId: number; reason?: string }
}
