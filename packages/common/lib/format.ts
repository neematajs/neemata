import type { ServerStreamConstructor, StreamMetadata } from './streams'

export abstract class BaseClientFormat {
  abstract mime: string

  abstract encode(data: any): ArrayBuffer
  abstract encodeRpc(
    callId: number,
    procedure: string,
    payload: any,
  ): ArrayBuffer
  abstract decode(buffer: ArrayBuffer): any
}

export type DecodeRpcContext = {
  getStream: (id: number) => InstanceType<ServerStreamConstructor>
  addStream: (id: number, metadata: StreamMetadata) => void
}

export abstract class BaseServerFormat {
  abstract accepts: string[]
  abstract mime: string

  abstract encode(data: any): ArrayBuffer
  abstract decode(buffer: ArrayBuffer): any
  abstract decodeRpc(
    buffer: ArrayBuffer,
    context: DecodeRpcContext,
  ): { callId: number; name: string; payload: any }
}
