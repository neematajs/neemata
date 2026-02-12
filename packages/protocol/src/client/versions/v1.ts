import type { BaseProtocolError } from '../../common/types.ts'
import type { ClientMessageTypePayload, MessageContext } from '../protocol.ts'
import {
  decodeNumber,
  decodeText,
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

  decodeMessage(context: MessageContext, buffer: Uint8Array) {
    const messageType = decodeNumber(buffer, 'Uint8')
    const payload = buffer.subarray(MessageByteLength.MessageType)
    switch (messageType) {
      // case ServerMessageType.Event: {
      //   const { event, data } = context.decoder.decode(payload)
      //   return { type: messageType, event, data }
      // }
      case ServerMessageType.RpcResponse: {
        const callId = decodeNumber(payload, 'Uint32')
        const isError = decodeNumber(payload, 'Uint8', MessageByteLength.CallId)
        const dataPayload = payload.subarray(
          MessageByteLength.CallId + MessageByteLength.MessageError,
        )

        if (isError) {
          const error = context.decoder.decode(dataPayload) as BaseProtocolError
          return { type: messageType, callId, error }
        } else {
          const result = context.decoder.decodeRPC(dataPayload, {
            addStream: (streamId, metadata) => {
              return context.addServerStream(streamId, metadata)
            },
          })
          return { type: messageType, callId, result }
        }
      }
      case ServerMessageType.RpcStreamResponse: {
        const callId = decodeNumber(payload, 'Uint32')
        const errorPayload = payload.subarray(MessageByteLength.CallId)
        const error =
          errorPayload.byteLength > 0
            ? (context.decoder.decode(errorPayload) as
                | BaseProtocolError
                | undefined)
            : undefined
        return { type: messageType, callId, error }
      }
      case ServerMessageType.RpcStreamChunk: {
        const callId = decodeNumber(payload, 'Uint32')
        const chunk = payload.subarray(MessageByteLength.CallId)
        return { type: messageType, callId, chunk }
      }
      case ServerMessageType.RpcStreamEnd: {
        const callId = decodeNumber(payload, 'Uint32')
        return { type: messageType, callId }
      }
      case ServerMessageType.RpcStreamAbort: {
        const callId = decodeNumber(payload, 'Uint32')
        const reasonPayload = payload.subarray(MessageByteLength.CallId)
        const reason =
          reasonPayload.byteLength > 0 ? decodeText(reasonPayload) : undefined
        return { type: messageType, callId, reason }
      }
      case ServerMessageType.Pong: {
        const nonce = decodeNumber(payload, 'Uint32')
        return { type: messageType, nonce }
      }
      case ServerMessageType.Ping: {
        const nonce = decodeNumber(payload, 'Uint32')
        return { type: messageType, nonce }
      }
      case ServerMessageType.ClientStreamPull: {
        const streamId = decodeNumber(payload, 'Uint32')
        const size = decodeNumber(payload, 'Uint32', MessageByteLength.StreamId)
        return { type: messageType, streamId, size }
      }
      case ServerMessageType.ClientStreamAbort: {
        const streamId = decodeNumber(payload, 'Uint32')
        const reasonPayload = payload.subarray(MessageByteLength.StreamId)
        const reason =
          reasonPayload.byteLength > 0 ? decodeText(reasonPayload) : undefined

        return { type: messageType, streamId, reason }
      }
      case ServerMessageType.ServerStreamPush: {
        const streamId = decodeNumber(payload, 'Uint32')
        const chunk = payload.subarray(MessageByteLength.StreamId)
        return { type: messageType, streamId, chunk }
      }
      case ServerMessageType.ServerStreamEnd: {
        const streamId = decodeNumber(payload, 'Uint32')
        const reasonPayload = payload.subarray(MessageByteLength.StreamId)
        const reason =
          reasonPayload.byteLength > 0 ? decodeText(reasonPayload) : undefined

        return { type: messageType, streamId, reason }
      }
      case ServerMessageType.ServerStreamAbort: {
        const streamId = decodeNumber(payload, 'Uint32')
        const reasonPayload = payload.subarray(MessageByteLength.StreamId)
        const reason =
          reasonPayload.byteLength > 0 ? decodeText(reasonPayload) : undefined

        return { type: messageType, streamId, reason }
      }

      default:
        throw new Error(`Unsupported message type: ${messageType}`)
    }
  }

  encodeMessage<T extends ClientMessageType>(
    context: MessageContext,
    messageType: T,
    payload: ClientMessageTypePayload[T],
  ) {
    switch (messageType) {
      case ClientMessageType.Rpc: {
        const {
          callId,
          procedure,
          payload: rpcPayload,
        } = payload as ClientMessageTypePayload[ClientMessageType.Rpc]
        const procedureBuffer = encodeText(procedure)
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
          encodeNumber(procedureBuffer.byteLength, 'Uint16'),
          procedureBuffer,
          context.encoder.encodeRPC(rpcPayload, {
            addStream: (blob) => context.addClientStream(blob),
          }),
        )
      }
      case ClientMessageType.RpcAbort: {
        const { callId, reason } =
          payload as ClientMessageTypePayload[ClientMessageType.RpcAbort]

        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
          reason ? encodeText(reason) : new Uint8Array(0),
        )
      }
      case ClientMessageType.RpcPull: {
        const { callId } =
          payload as ClientMessageTypePayload[ClientMessageType.RpcPull]

        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
        )
      }
      case ClientMessageType.Ping: {
        const { nonce } =
          payload as ClientMessageTypePayload[ClientMessageType.Ping]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(nonce, 'Uint32'),
        )
      }
      case ClientMessageType.Pong: {
        const { nonce } =
          payload as ClientMessageTypePayload[ClientMessageType.Pong]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(nonce, 'Uint32'),
        )
      }
      case ClientMessageType.ClientStreamPush: {
        const { streamId, chunk } =
          payload as ClientMessageTypePayload[ClientMessageType.ClientStreamPush]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          chunk,
        )
      }
      case ClientMessageType.ClientStreamEnd: {
        const { streamId } =
          payload as ClientMessageTypePayload[ClientMessageType.ClientStreamEnd]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
        )
      }
      case ClientMessageType.ClientStreamAbort: {
        const { streamId, reason } =
          payload as ClientMessageTypePayload[ClientMessageType.ClientStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          reason ? encodeText(reason) : new Uint8Array(0),
        )
      }
      case ClientMessageType.ServerStreamPull: {
        const { streamId, size } =
          payload as ClientMessageTypePayload[ClientMessageType.ServerStreamPull]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          encodeNumber(size, 'Uint32'),
        )
      }
      case ClientMessageType.ServerStreamAbort: {
        const { streamId, reason } =
          payload as ClientMessageTypePayload[ClientMessageType.ServerStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
          reason ? encodeText(reason) : new Uint8Array(0),
        )
      }

      default:
        throw new Error(`Unsupported message type: ${messageType}`)
    }
  }
}
