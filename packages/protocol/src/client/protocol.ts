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
import type {
  BaseProtocolError,
  DecodedMessage,
  EncodeRPCStreams,
  SharedClientPayload,
  SharedServerPayload,
} from '../common/types.ts'
import type { BaseClientDecoder, BaseClientEncoder } from './codec.ts'
import type { ProtocolClientBlobStream } from './stream.ts'

export { ProtocolError } from '../common/error.ts'

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

export type ClientMessageTypePayload = SharedClientPayload & {
  [ClientMessageType.Rpc]: { callId: number; procedure: string; payload: any }
}

export type ServerMessageTypePayload = SharedServerPayload & {
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
}

export abstract class ProtocolVersionInterface {
  abstract version: ProtocolVersion
  abstract decodeMessage(
    context: MessageContext,
    buffer: ArrayBufferView,
  ): DecodedMessage<ServerMessageTypePayload>
  abstract encodeMessage<T extends ClientMessageType>(
    context: MessageContext,
    messageType: T,
    payload: ClientMessageTypePayload[T],
  ): any
}
