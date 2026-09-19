import type {
  ClientMessageType,
  ProtocolVersion,
  ServerMessageType,
} from '../common/enums.ts'
import type {
  DecodedMessage,
  EncodeRPCStreams,
  SharedClientPayload,
  SharedServerPayload,
} from '../common/types.ts'
import type { MessageContext } from './types.ts'

export { ProtocolError } from '../common/error.ts'

export abstract class ProtocolVersionInterface {
  abstract version: ProtocolVersion
  abstract decodeMessage(
    context: MessageContext,
    buffer: ArrayBufferView,
  ): DecodedMessage<ClientMessageTypePayload>
  abstract encodeMessage<T extends ServerMessageType = ServerMessageType>(
    context: MessageContext,
    messageType: T,
    payload: ServerMessageTypePayload[T],
  ): ArrayBufferView
}

export type ServerMessageTypePayload = SharedServerPayload & {
  [ServerMessageType.RpcResponse]: {
    callId: number
    result: any
    streams: EncodeRPCStreams
    // whatever the api layer threw; the encoder serializes it as is
    error: unknown
  }
  [ServerMessageType.RpcStreamResponse]: { callId: number }
}

export type ClientMessageTypePayload = SharedClientPayload & {
  [ClientMessageType.Rpc]: {
    rpc: {
      callId: number
      procedure: string
      payload: unknown
    }
  }
}
