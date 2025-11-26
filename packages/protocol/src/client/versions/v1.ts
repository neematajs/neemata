import type { BaseProtocolError } from '../../common/types.ts'
import type { ClientMessageTypePayload, MessageContext } from '../protocol.ts'
import { decodeNumber, encodeNumber, encodeText } from '../../common/binary.ts'
import {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '../../common/enums.ts'
import { ProtocolVersionInterface } from '../protocol.ts'
import { ProtocolServerBlobStream } from '../stream.ts'

export class ProtocolVersion1 extends ProtocolVersionInterface {
  version = ProtocolVersion.v1

  decodeMessage(context: MessageContext, buffer: Uint8Array) {
    const messageType = decodeNumber(buffer, 'Uint8')
    const payload = buffer.subarray(Uint8Array.BYTES_PER_ELEMENT)
    switch (messageType) {
      // case ServerMessageType.Event: {
      //   const { event, data } = context.decoder.decode(payload)
      //   return { type: messageType, event, data }
      // }
      case ServerMessageType.RpcResponse: {
        const callId = decodeNumber(payload, 'Uint32')
        const isError = decodeNumber(
          payload,
          'Uint8',
          Uint32Array.BYTES_PER_ELEMENT,
        )
        const dataPayload = payload.subarray(
          Uint32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT,
        )

        if (isError) {
          const error = context.decoder.decode(dataPayload) as BaseProtocolError
          return { type: messageType, callId, error }
        } else {
          const result = context.decoder.decodeRPC(dataPayload, {
            addStream: (streamId, metadata) => {
              const stream = new ProtocolServerBlobStream(metadata, {
                pull: (size) => {
                  context.transport.send(
                    this.encodeMessage(
                      context,
                      ClientMessageType.ServerStreamPull,
                      { streamId, size: size || 65535 /* 64kb */ },
                    ),
                  )
                },
              })
              context.serverStreams.add(streamId, stream)
              return stream
            },
            getStream: (id) => {
              return context.serverStreams.get(id) as ProtocolServerBlobStream
            },
          })
          return { type: messageType, callId, result }
        }
      }
      case ServerMessageType.RpcStreamResponse: {
        const callId = decodeNumber(payload, 'Uint32')
        const errorPayload = payload.subarray(Uint32Array.BYTES_PER_ELEMENT)
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
        const chunk = payload.subarray(Uint32Array.BYTES_PER_ELEMENT)
        return { type: messageType, callId, chunk }
      }
      case ServerMessageType.RpcStreamEnd: {
        const callId = decodeNumber(payload, 'Uint32')
        return { type: messageType, callId }
      }
      case ServerMessageType.RpcStreamAbort: {
        const callId = decodeNumber(payload, 'Uint32')
        return { type: messageType, callId }
      }
      case ServerMessageType.ClientStreamPull: {
        const streamId = decodeNumber(payload, 'Uint32')
        const size = decodeNumber(
          payload,
          'Uint32',
          Uint32Array.BYTES_PER_ELEMENT,
        )
        return { type: messageType, streamId, size }
      }
      case ServerMessageType.ClientStreamAbort: {
        const streamId = decodeNumber(payload, 'Uint32')
        return { type: messageType, streamId }
      }
      case ServerMessageType.ServerStreamPush: {
        const streamId = decodeNumber(payload, 'Uint32')
        const chunk = payload.subarray(Uint32Array.BYTES_PER_ELEMENT)
        return { type: messageType, streamId, chunk }
      }
      case ServerMessageType.ServerStreamEnd: {
        const streamId = decodeNumber(payload, 'Uint32')
        return { type: messageType, streamId }
      }
      case ServerMessageType.ServerStreamAbort: {
        const streamId = decodeNumber(payload, 'Uint32')
        return { type: messageType, streamId }
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
            addStream: (blob) => {
              const streamId = context.streamId()
              return context.clientStreams.add(
                blob.source,
                streamId,
                blob.metadata,
              )
            },
            getStream: (id) => {
              return context.clientStreams.get(id)
            },
          }).buffer,
        )
      }
      case ClientMessageType.RpcAbort: {
        const { callId } =
          payload as ClientMessageTypePayload[ClientMessageType.RpcAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
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
        const { streamId } =
          payload as ClientMessageTypePayload[ClientMessageType.ClientStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
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
        const { streamId } =
          payload as ClientMessageTypePayload[ClientMessageType.ServerStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
        )
      }

      default:
        throw new Error(`Unsupported message type: ${messageType}`)
    }
  }
}
