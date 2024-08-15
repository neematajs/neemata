import type { ApiBlob } from './blob.ts'
import type { ApiBlobMetadata, Pattern, Rpc, RpcResponse } from './types.ts'

export interface EncodeRpcContext {
  getStream: (id: number) => any
  addStream: (blob: ApiBlob) => { id: number; metadata: ApiBlobMetadata }
}

export interface DecodeRpcContext {
  getStream: (id: number) => any
  addStream: (id: number, metadata: ApiBlobMetadata) => any
}

export interface BaseClientDecoder {
  decode(buffer: ArrayBuffer): any
  decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): RpcResponse
}

export interface BaseClientEncoder {
  encode(data: any): ArrayBuffer
  encodeRpc(rpc: Rpc, context: EncodeRpcContext): ArrayBuffer
}

export abstract class BaseClientFormat
  implements BaseClientDecoder, BaseClientEncoder
{
  abstract contentType: string

  abstract encode(data: any): ArrayBuffer
  abstract encodeRpc(rpc: Rpc, context: EncodeRpcContext): ArrayBuffer
  abstract decode(buffer: ArrayBuffer): any
  abstract decodeRpc(
    buffer: ArrayBuffer,
    context: DecodeRpcContext,
  ): RpcResponse
}

export interface BaseServerDecoder {
  accept: Pattern[]
  decode(buffer: ArrayBuffer): any
  decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): Rpc
}

export interface BaseServerEncoder {
  contentType: string
  encode(data: any): ArrayBuffer
  encodeRpc(rpc: RpcResponse, context: EncodeRpcContext): ArrayBuffer
}

export abstract class BaseServerFormat
  implements BaseServerDecoder, BaseServerEncoder
{
  abstract accept: Pattern[]
  abstract contentType: string

  abstract encode(data: any): ArrayBuffer
  abstract encodeRpc(rpc: RpcResponse, context: EncodeRpcContext): ArrayBuffer
  abstract decode(buffer: ArrayBuffer): any
  abstract decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): Rpc
}
