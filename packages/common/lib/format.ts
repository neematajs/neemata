import type { Rpc, StreamMetadata } from './types.ts'

export interface ServerStreamConstructor {
  new (
    id: number,
    metadata: StreamMetadata,
    read?: (size: number) => void,
    highWaterMark?: number,
  ): {
    readonly id: number
    readonly metadata: StreamMetadata
    push(buffer: Uint8Array | null): boolean
  }
}

export abstract class BaseClientFormat {
  abstract mime: string

  abstract encode(data: any): ArrayBuffer
  abstract encodeRpc(rpc: Rpc): ArrayBuffer
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
  abstract decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): Rpc
}
