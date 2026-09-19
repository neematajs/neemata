/// <reference types="node" />

import type { ServerMessageTypePayload } from '../protocol.ts'
import type { MessageContext } from '../types.ts'
import {
  concat,
  decodeOptionalText,
  encodeFrame,
  encodeNumber,
  encodeText,
} from '../../common/binary.ts'
import {
  ClientMessageType,
  MessageByteLength,
  ProtocolVersion,
  ServerMessageType,
} from '../../common/enums.ts'
import { ProtocolVersionInterface } from '../protocol.ts'

export class ProtocolVersion1 extends ProtocolVersionInterface {
  version = ProtocolVersion.v1
  decodeMessage(context: MessageContext, buffer: Buffer) {
    const messageType = buffer.readUInt8(0)
    const messagePayload = buffer.subarray(MessageByteLength.MessageType)
    switch (messageType) {
      case ClientMessageType.Rpc: {
        const callId = messagePayload.readUInt32LE(0)
        const procedureLength = messagePayload.readUInt16LE(
          MessageByteLength.CallId,
        )
        const procedureOffset =
          MessageByteLength.CallId + MessageByteLength.ProcedureLength
        // toString/subarray silently clamp to the buffer end, so a truncated
        // frame would decode into a wrong procedure/payload instead of failing
        if (procedureOffset + procedureLength > messagePayload.byteLength) {
          throw new Error(
            `Malformed RPC message: procedure length ${procedureLength} exceeds frame size`,
          )
        }
        const procedure = messagePayload.toString(
          'utf-8',
          procedureOffset,
          procedureOffset + procedureLength,
        )
        const formatPayload = messagePayload.subarray(
          procedureOffset + procedureLength,
        )
        const payload = context.decoder.decodeRPC(formatPayload, {
          addStream: (streamId, metadata) => {
            return context.addClientStream({ callId, streamId, metadata })
          },
        })

        return { type: messageType, rpc: { callId, procedure, payload } }
      }
      case ClientMessageType.RpcAbort: {
        const callId = messagePayload.readUInt32LE(0)
        const reason = decodeOptionalText(
          messagePayload,
          MessageByteLength.CallId,
        )
        return { type: messageType, callId, reason }
      }
      case ClientMessageType.RpcStreamPull: {
        // readUInt32LE would silently succeed on an oversized frame; reject
        // anything that isn't exactly callId+size so garbage can't smuggle in
        if (
          messagePayload.byteLength !==
          MessageByteLength.CallId + MessageByteLength.ChunkSize
        ) {
          throw new Error(
            `Malformed RpcStreamPull message: expected ${
              MessageByteLength.CallId + MessageByteLength.ChunkSize
            } bytes, got ${messagePayload.byteLength}`,
          )
        }
        const callId = messagePayload.readUInt32LE(0)
        const size = messagePayload.readUInt32LE(MessageByteLength.CallId)
        return { type: messageType, callId, size }
      }
      case ClientMessageType.Ping:
      case ClientMessageType.Pong: {
        const nonce = messagePayload.readUInt32LE(0)
        return { type: messageType, nonce }
      }
      case ClientMessageType.ServerBlobAbort:
      case ClientMessageType.ClientBlobAbort: {
        const streamId = messagePayload.readUInt32LE(0)
        const reason = decodeOptionalText(
          messagePayload,
          MessageByteLength.StreamId,
        )
        return { type: messageType, streamId, reason }
      }
      case ClientMessageType.ServerBlobPull: {
        const streamId = messagePayload.readUInt32LE(0)
        const size = messagePayload.readUInt32LE(MessageByteLength.StreamId)
        return { type: messageType, streamId, size }
      }
      case ClientMessageType.ClientBlobEnd: {
        return { type: messageType, streamId: messagePayload.readUInt32LE(0) }
      }
      case ClientMessageType.ClientBlobPush: {
        const streamId = messagePayload.readUInt32LE(0)
        const chunk = messagePayload.subarray(MessageByteLength.StreamId)
        return { type: messageType, streamId, chunk }
      }

      default:
        throw new Error(`Unsupported message type: ${messageType}`)
    }
  }

  encodeMessage<T extends ServerMessageType>(
    context: MessageContext,
    messageType: T,
    payload: ServerMessageTypePayload[T],
  ) {
    switch (messageType) {
      case ServerMessageType.RpcResponse: {
        const { callId, result, streams, error } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcResponse]
        return concat(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
          encodeNumber(error ? 1 : 0, 'Uint8'),
          error
            ? context.encoder.encode(error)
            : context.encoder.encodeRPC(result, streams),
        )
      }
      case ServerMessageType.RpcStreamEnd:
      case ServerMessageType.RpcStreamResponse: {
        const { callId } = payload as ServerMessageTypePayload[
          | ServerMessageType.RpcStreamEnd
          | ServerMessageType.RpcStreamResponse]
        return encodeFrame(messageType, callId)
      }
      case ServerMessageType.RpcStreamChunk: {
        const { callId, chunk } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcStreamChunk]
        return encodeFrame(messageType, callId, chunk)
      }
      case ServerMessageType.RpcStreamAbort: {
        const { callId, reason } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcStreamAbort]
        return encodeFrame(
          messageType,
          callId,
          reason ? encodeText(reason) : undefined,
        )
      }
      case ServerMessageType.Pong:
      case ServerMessageType.Ping: {
        const { nonce } = payload as ServerMessageTypePayload[
          | ServerMessageType.Pong
          | ServerMessageType.Ping]
        return encodeFrame(messageType, nonce)
      }
      case ServerMessageType.ClientBlobPull: {
        const { size, streamId } =
          payload as ServerMessageTypePayload[ServerMessageType.ClientBlobPull]
        return encodeFrame(messageType, streamId, encodeNumber(size, 'Uint32'))
      }
      case ServerMessageType.ServerBlobAbort:
      case ServerMessageType.ClientBlobAbort: {
        const { streamId, reason } = payload as ServerMessageTypePayload[
          | ServerMessageType.ServerBlobAbort
          | ServerMessageType.ClientBlobAbort]
        return encodeFrame(
          messageType,
          streamId,
          reason ? encodeText(reason) : undefined,
        )
      }
      case ServerMessageType.ServerBlobPush: {
        const { streamId, chunk } =
          payload as ServerMessageTypePayload[ServerMessageType.ServerBlobPush]
        return encodeFrame(messageType, streamId, chunk)
      }
      case ServerMessageType.ServerBlobEnd: {
        const { streamId } =
          payload as ServerMessageTypePayload[ServerMessageType.ServerBlobEnd]
        return encodeFrame(messageType, streamId)
      }

      default:
        throw new Error(`Unsupported message type: ${messageType}`)
    }
  }
}
