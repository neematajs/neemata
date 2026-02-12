import type { ServerMessageTypePayload } from '../protocol.ts'
import type { MessageContext } from '../types.ts'
import { decodeText, encodeNumber, encodeText } from '../../common/binary.ts'
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
    const messageType = buffer.readUint8(0)
    const messagePayload = buffer.subarray(MessageByteLength.MessageType)
    switch (messageType) {
      case ClientMessageType.Rpc: {
        const callId = messagePayload.readUint32LE(0)
        const procedureLength = messagePayload.readUInt16LE(
          MessageByteLength.CallId,
        )
        const procedureOffset =
          MessageByteLength.CallId + MessageByteLength.ProcedureLength
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
      case ClientMessageType.RpcPull: {
        const callId = messagePayload.readUInt32LE(0)
        return { type: messageType, callId }
      }
      case ClientMessageType.RpcAbort: {
        const callId = messagePayload.readUInt32LE(0)
        const reasonPayload = messagePayload.subarray(MessageByteLength.CallId)
        const reason =
          reasonPayload.byteLength > 0 ? decodeText(reasonPayload) : undefined
        return { type: messageType, callId, reason }
      }
      case ClientMessageType.Ping: {
        const nonce = messagePayload.readUInt32LE(0)
        return { type: messageType, nonce }
      }
      case ClientMessageType.Pong: {
        const nonce = messagePayload.readUInt32LE(0)
        return { type: messageType, nonce }
      }
      case ClientMessageType.ServerStreamAbort: {
        const streamId = messagePayload.readUInt32LE(0)
        const reasonPayload = messagePayload.subarray(
          MessageByteLength.StreamId,
        )
        const reason =
          reasonPayload.byteLength > 0 ? decodeText(reasonPayload) : undefined
        return { type: messageType, streamId, reason }
      }
      case ClientMessageType.ServerStreamPull: {
        const streamId = messagePayload.readUInt32LE(0)
        const size = messagePayload.readUInt32LE(MessageByteLength.StreamId)
        return { type: messageType, streamId, size }
      }
      case ClientMessageType.ClientStreamAbort: {
        const streamId = messagePayload.readUInt32LE(0)
        const reasonPayload = messagePayload.subarray(
          MessageByteLength.StreamId,
        )
        const reason =
          reasonPayload.byteLength > 0 ? decodeText(reasonPayload) : undefined
        return { type: messageType, streamId, reason }
      }
      case ClientMessageType.ClientStreamEnd: {
        return { type: messageType, streamId: messagePayload.readUInt32LE(0) }
      }
      case ClientMessageType.ClientStreamPush: {
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
      // case ServerMessageType.Event: {
      //   const { event, data } =
      //     payload as ServerMessageTypePayload[ServerMessageType.Event]
      //   return this.encode(
      //     encodeNumber(messageType, 'Uint8'),
      //     context.encoder.encode({ event, data }),
      //   )
      // }
      case ServerMessageType.RpcResponse: {
        const { callId, result, streams, error } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcResponse]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
          encodeNumber(error ? 1 : 0, 'Uint8'),
          error
            ? context.encoder.encode(error)
            : context.encoder.encodeRPC(result, streams),
        )
      }
      case ServerMessageType.RpcStreamResponse: {
        const { callId } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcStreamResponse]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
        )
      }
      case ServerMessageType.RpcStreamChunk: {
        const { callId, chunk } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcStreamChunk]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
          chunk,
        )
      }
      case ServerMessageType.RpcStreamEnd: {
        const { callId } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcStreamEnd]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
        )
      }
      case ServerMessageType.RpcStreamAbort: {
        const { callId, reason } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
          reason ? encodeText(reason) : Buffer.alloc(0),
        )
      }
      case ServerMessageType.Pong: {
        const { nonce } =
          payload as ServerMessageTypePayload[ServerMessageType.Pong]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(nonce, 'Uint32'),
        )
      }
      case ServerMessageType.Ping: {
        const { nonce } =
          payload as ServerMessageTypePayload[ServerMessageType.Ping]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(nonce, 'Uint32'),
        )
      }
      case ServerMessageType.ClientStreamPull: {
        const { size, streamId } =
          payload as ServerMessageTypePayload[ServerMessageType.ClientStreamPull]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          encodeNumber(size, 'Uint32'),
        )
      }
      case ServerMessageType.ClientStreamAbort: {
        const { streamId, reason } =
          payload as ServerMessageTypePayload[ServerMessageType.ClientStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          reason ? encodeText(reason) : Buffer.alloc(0),
        )
      }
      case ServerMessageType.ServerStreamPush: {
        const { streamId, chunk } =
          payload as ServerMessageTypePayload[ServerMessageType.ServerStreamPush]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          chunk,
        )
      }
      case ServerMessageType.ServerStreamEnd: {
        const { streamId } =
          payload as ServerMessageTypePayload[ServerMessageType.ServerStreamEnd]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
        )
      }
      case ServerMessageType.ServerStreamAbort: {
        const { streamId, reason } =
          payload as ServerMessageTypePayload[ServerMessageType.ServerStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          reason ? encodeText(reason) : Buffer.alloc(0),
        )
      }

      default:
        throw new Error(`Unsupported message type: ${messageType}`)
    }
  }
}
