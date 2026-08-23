import type {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '../common/enums.ts'
import type { EncodeRPCStreams } from '../common/types.ts'
import type { MessageContext } from './types.ts'
import { concat } from '../common/binary.ts'

export { ProtocolError, toProtocolError } from '../common/error.ts'

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
