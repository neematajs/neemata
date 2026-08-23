import type {
  ProtocolBlob,
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import type {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '../common/enums.ts'
import type { BaseProtocolError, EncodeRPCStreams } from '../common/types.ts'
import type { BaseClientDecoder, BaseClientEncoder } from './codec.ts'
import type { ProtocolClientBlobStream } from './stream.ts'
import { concat } from '../common/binary.ts'

export type MessageContext = {
  decoder: BaseClientDecoder
  encoder: BaseClientEncoder
  addClientStream: (blob: ProtocolBlob) => ProtocolClientBlobStream
  addServerStream: (
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) => ProtocolBlobInterface
  transport: { send: (buffer: ArrayBufferView) => void }
  streamId: () => number
}

export type ClientMessageTypePayload = {
  [ClientMessageType.Rpc]: { callId: number; procedure: string; payload: any }
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
  [ServerMessageType.ServerBlobAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ServerBlobEnd]: { streamId: number }
  [ServerMessageType.ServerBlobPush]: {
    streamId: number
    chunk: ArrayBufferView
  }
  [ServerMessageType.ClientBlobAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ClientBlobPull]: { streamId: number; size: number }
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

export { ProtocolError, toProtocolError } from '../common/error.ts'
