import type { ServerMessageTypePayload } from '../protocol.ts'
import type { MessageContext } from '../utils.ts'
import { encodeNumber } from '../../common/binary.ts'
import {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '../../common/enums.ts'
import { ProtocolVersionInterface } from '../protocol.ts'

export class ProtocolVersion1 extends ProtocolVersionInterface {
  version = ProtocolVersion.v1
  decodeMessage(context: MessageContext, buffer: Buffer) {
    const messageType = buffer.readUint8(0)
    const payload = buffer.subarray(Uint8Array.BYTES_PER_ELEMENT)
    switch (messageType) {
      case ClientMessageType.Rpc: {
        const callId = payload.readUint32LE(0)
        const procedureLength = payload.readUInt16LE(
          Uint32Array.BYTES_PER_ELEMENT,
        )
        const procedureOffset =
          Uint32Array.BYTES_PER_ELEMENT + Uint16Array.BYTES_PER_ELEMENT
        const procedure = payload.toString(
          'utf-8',
          procedureOffset,
          procedureOffset + procedureLength,
        )
        const formatPayload = payload.subarray(
          procedureOffset + procedureLength,
        )
        const rpcPayload = context.decoder.decodeRPC(formatPayload, {
          addStream: (streamId, metadata) => {
            return context.clientStreams.add(streamId, metadata, (size) => {
              context.transport.send?.(
                context.connectionId,
                this.encodeMessage(
                  context,
                  ServerMessageType.ClientStreamPull,
                  { size, streamId },
                ),
              )
            })
          },
          getStream: (id) => {
            return context.clientStreams.get(id)
          },
        })
        return {
          type: messageType,
          rpc: { callId, procedure, payload: rpcPayload },
        }
      }
      case ClientMessageType.RpcAbort: {
        return { type: messageType, callId: payload.readUInt32LE(0) }
      }
      case ClientMessageType.ServerStreamAbort: {
        return { type: messageType, streamId: payload.readUInt32LE(0) }
      }
      case ClientMessageType.ServerStreamPull: {
        const streamId = payload.readUInt32LE(0)
        const size = payload.readUInt32LE(Uint32Array.BYTES_PER_ELEMENT)
        return { type: messageType, streamId, size }
      }
      case ClientMessageType.ClientStreamAbort:
      case ClientMessageType.ClientStreamEnd: {
        return { type: messageType, streamId: payload.readUInt32LE(0) }
      }
      case ClientMessageType.ClientStreamPush: {
        const streamId = payload.readUInt32LE(0)
        const chunk = payload.subarray(Uint32Array.BYTES_PER_ELEMENT)
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
                  const stream = context.serverStreams.add(streamId, blob)
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
                getStream: (id) => {
                  return context.serverStreams.get(id)
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
