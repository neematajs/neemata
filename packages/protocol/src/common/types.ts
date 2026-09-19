import type { ProtocolBlobMetadata } from './blob.ts'
import type { ClientMessageType, ServerMessageType } from './enums.ts'

export interface BaseProtocolError {
  code: string
  message: string
  data?: any
}

export type ProtocolRPCPayload = unknown

export type EncodeRPCStreams = Record<number, ProtocolBlobMetadata>

export interface DecodeRPCContext<T = unknown> {
  addStream: (id: number, metadata: ProtocolBlobMetadata) => T
}

/** A decoded frame: its payload tagged with the message type it came from. */
export type DecodedMessage<Payloads> = {
  [K in keyof Payloads]: { type: K } & Payloads[K]
}[keyof Payloads]

/**
 * Frames both halves agree on verbatim. Only the RPC call and its response
 * carry side-specific payloads, so each half declares just those on top.
 */
export type SharedClientPayload = {
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

export type SharedServerPayload = {
  [ServerMessageType.RpcStreamChunk]: { callId: number; chunk: ArrayBufferView }
  [ServerMessageType.RpcStreamEnd]: { callId: number }
  [ServerMessageType.RpcStreamAbort]: { callId: number; reason?: string }
  [ServerMessageType.Ping]: { nonce: number }
  [ServerMessageType.Pong]: { nonce: number }
  [ServerMessageType.ClientBlobAbort]: { streamId: number; reason?: string }
  [ServerMessageType.ClientBlobPull]: { streamId: number; size: number }
  [ServerMessageType.ServerBlobPush]: {
    streamId: number
    chunk: ArrayBufferView
  }
  [ServerMessageType.ServerBlobEnd]: { streamId: number }
  [ServerMessageType.ServerBlobAbort]: { streamId: number; reason?: string }
}
