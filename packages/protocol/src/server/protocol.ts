import type { ServerMessageType } from '../common/enums.ts'
import type { MessageContext } from './utils.ts'

export class ProtocolError extends Error {
  code: string
  data?: any

  constructor(code: string, message?: string, data?: any) {
    super(message)
    this.code = code
    this.data = data
  }

  get message() {
    return `${this.code} ${super.message}`
  }

  toString() {
    return `${this.code} ${this.message}`
  }

  toJSON() {
    return { code: this.code, message: this.message, data: this.data }
  }
}

export abstract class ProtocolVersionInterface {
  abstract decodeMessage(context: MessageContext, buffer: Buffer): any
  abstract encodeMessage<T extends ServerMessageType = ServerMessageType>(
    context: MessageContext,
    messageType: T,
    payload: ServerMessageTypePayload[T],
  ): any

  protected encode(...chunks: (ArrayBuffer | Buffer)[]): ArrayBuffer {
    const buffer = Buffer.concat(
      chunks.map((chunk) =>
        chunk instanceof ArrayBuffer ? Buffer.from(chunk) : chunk,
      ),
    )
    // TODO: here we copy the buffer, but is it necessary?
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    )
  }
}

export type ServerMessageTypePayload = {
  [ServerMessageType.Event]: { event: string; data: any }
  [ServerMessageType.RpcResponse]: {
    callId: number
    result: any
    error: any | null
  }
  [ServerMessageType.RpcStreamAbort]: { callId: number }
  [ServerMessageType.RpcStreamEnd]: { callId: number }
  [ServerMessageType.RpcStreamChunk]: { callId: number; chunk: Buffer }
  [ServerMessageType.RpcStreamResponse]: { callId: number }
  [ServerMessageType.ClientStreamAbort]: { streamId: number }
  [ServerMessageType.ClientStreamPull]: { streamId: number; size: number }
  [ServerMessageType.ServerStreamAbort]: { streamId: number }
  [ServerMessageType.ServerStreamEnd]: { streamId: number }
  [ServerMessageType.ServerStreamPush]: { streamId: number; chunk: Buffer }
}
