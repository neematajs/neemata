import type { ServerMessageTypePayload } from '../protocol.ts'
import type { MessageContext } from '../utils.ts'
import { encodeNumber } from '../../common/binary.ts'
import { ClientMessageType, ServerMessageType } from '../../common/enums.ts'
import { ProtocolVersionInterface } from '../protocol.ts'

export class ProtocolVersion1 extends ProtocolVersionInterface {
  decodeMessage(context: MessageContext, buffer: Buffer) {
    const messageType = buffer.readUint8(0)
    const payload = buffer.subarray(Uint8Array.BYTES_PER_ELEMENT)
    switch (messageType) {
      case ClientMessageType.Rpc: {
        const rpc = context.decoder.decodeRPC(buffer, {
          addStream: (streamId, callId, metadata) => {
            return context.clientStreams.add(
              context.connectionId,
              streamId,
              metadata,
              (size) => {
                context.transport.send?.(
                  context.connectionId,
                  this.encodeMessage(
                    context,
                    ServerMessageType.ClientStreamPull,
                    { size, streamId },
                  ),
                )
              },
            )
          },
          getStream: (id) => {
            return context.clientStreams.get(context.connectionId, id)
          },
        })
        return { type: messageType, rpc }
      }
      case ClientMessageType.RpcAbort: {
        return { type: messageType, callId: payload.readUInt32LE(0) }
      }
      case ClientMessageType.ClientStreamAbort:
      case ClientMessageType.ClientStreamEnd:
      case ClientMessageType.ClientStreamPush:
      case ClientMessageType.ServerStreamAbort:
      case ClientMessageType.ServerStreamPull: {
        return { type: messageType, streamId: payload.readUInt32LE(0) }
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
      case ServerMessageType.Event: {
        const { event, data } =
          payload as ServerMessageTypePayload[ServerMessageType.Event]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          context.encoder.encode({ event, data }),
        )
      }
      case ServerMessageType.RpcResponse: {
        const { callId, result, error } =
          payload as ServerMessageTypePayload[ServerMessageType.RpcResponse]
        return this.encode(
          encodeNumber(messageType, 'Uint8'),
          context.encoder.encodeRPC(
            { callId, result, error },
            {
              addStream: (blob) => {
                const streamId = context.streamId()
                const stream = context.serverStreams.add(streamId, blob)
                stream.on('data', (chunk) => {
                  stream.pause()
                  const buf = Buffer.from(chunk)
                  context.transport.send?.(
                    context.connectionId,
                    this.encode(
                      encodeNumber(ServerMessageType.ServerStreamPush, 'Uint8'),
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
                      encodeNumber(ServerMessageType.ServerStreamEnd, 'Uint8'),
                      encodeNumber(streamId, 'Uint32'),
                    ),
                  )
                })
                return context.serverStreams.add(streamId, blob)
              },
              getStream: (id) => {
                return context.serverStreams.get(id)
              },
            },
          ),
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
