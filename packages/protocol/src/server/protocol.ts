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
  [ServerMessageType.ClientStreamAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ClientStreamPull]: { streamId: number; size: number }
  [ServerMessageType.ServerStreamAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ServerStreamEnd]: { streamId: number }
  [ServerMessageType.ServerStreamPush]: {
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
  [ClientMessageType.RpcPull]: { callId: number }
  [ClientMessageType.RpcAbort]: { callId: number; reason?: string }
  [ClientMessageType.ClientStreamPush]: {
    streamId: number
    chunk: ArrayBufferView
  }
  [ClientMessageType.ClientStreamEnd]: { streamId: number }
  [ClientMessageType.ClientStreamAbort]: { streamId: number; reason?: string }
  [ClientMessageType.ServerStreamPull]: { streamId: number; size: number }
  [ClientMessageType.ServerStreamAbort]: { streamId: number; reason?: string }
}
