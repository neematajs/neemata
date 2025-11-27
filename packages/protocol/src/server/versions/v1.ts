import type { ServerMessageTypePayload } from '../protocol.ts'
import type { MessageContext } from '../utils.ts'
import { encodeNumber } from '../../common/binary.ts'
import {
  ClientMessageType,
  Lengths,
  ProtocolVersion,
  ServerMessageType,
} from '../../common/enums.ts'
import { ProtocolVersionInterface } from '../protocol.ts'

export class ProtocolVersion1 extends ProtocolVersionInterface {
  version = ProtocolVersion.v1
  decodeMessage(context: MessageContext, buffer: Buffer) {
    const messageType = buffer.readUint8(0)
    const messagePayload = buffer.subarray(Lengths.MessageType)
    switch (messageType) {
      case ClientMessageType.Rpc: {
        const callId = messagePayload.readUint32LE(0)
        const procedureLength = messagePayload.readUInt16LE(Lengths.CallId)
        const procedureOffset = Lengths.CallId + Lengths.Procedure
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
            return context.addClientStream({
              callId,
              streamId,
              metadata,
              pull: (size) => {
                context.transport.send?.(
                  context.connectionId,
                  this.encodeMessage(
                    context,
                    ServerMessageType.ClientStreamPull,
                    { size, streamId },
                  ),
                )
              },
            })
          },
        })
        return { type: messageType, rpc: { callId, procedure, payload } }
      }
      case ClientMessageType.RpcAbort: {
        return { type: messageType, callId: messagePayload.readUInt32LE(0) }
      }
      case ClientMessageType.ServerStreamAbort: {
        return { type: messageType, streamId: messagePayload.readUInt32LE(0) }
      }
      case ClientMessageType.ServerStreamPull: {
        const streamId = messagePayload.readUInt32LE(0)
        const size = messagePayload.readUInt32LE(Lengths.StreamId)
        return { type: messageType, streamId, size }
      }
      case ClientMessageType.ClientStreamAbort:
      case ClientMessageType.ClientStreamEnd: {
        return { type: messageType, streamId: messagePayload.readUInt32LE(0) }
      }
      case ClientMessageType.ClientStreamPush: {
        const streamId = messagePayload.readUInt32LE(0)
        const chunk = messagePayload.subarray(Lengths.StreamId)
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
        const { callId, result, error } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcResponse]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
          encodeNumber(error ? 1 : 0, 'Uint8'),
          error
            ? context.encoder.encode(error)
            : context.encoder.encodeRPC(result, {
                addStream: (blob) => {
                  const streamId = context.streamId()
                  const stream = context.addServerStream({
                    callId,
                    streamId,
                    blob,
                  })
                  stream.on('data', (chunk) => {
                    stream.pause()
                    const buf = Buffer.from(chunk)
                    context.transport.send?.(
                      context.connectionId,
                      this.encode(
                        encodeNumber(
                          ServerMessageType.ServerStreamPush,
                          'Uint8',
                        ),
                        encodeNumber(streamId, 'Uint32'),
                        buf,
                      ),
                    )
                  })
                  stream.on('error', () => {
                    context.transport.send?.(
                      context.connectionId,
                      this.encode(
                        encodeNumber(
                          ServerMessageType.ServerStreamAbort,
                          'Uint8',
                        ),
                        encodeNumber(streamId, 'Uint32'),
                      ),
                    )
                  })
                  stream.on('end', () => {
                    context.transport.send?.(
                      context.connectionId,
                      this.encode(
                        encodeNumber(
                          ServerMessageType.ServerStreamEnd,
                          'Uint8',
                        ),
                        encodeNumber(streamId, 'Uint32'),
                      ),
                    )
                  })
                  return stream
                },
              }),
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
        const { callId } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(callId, 'Uint32'),
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
        const { streamId } =
          payload as ServerMessageTypePayload[ServerMessageType.ClientStreamAbort]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          encodeNumber(streamId, 'Uint32'),
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
        const { streamId } =
          payload as ServerMessageTypePayload[ServerMessageType.ServerStreamAbort]
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
