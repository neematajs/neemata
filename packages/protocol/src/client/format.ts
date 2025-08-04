import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPC,
  ProtocolRPCResponse,
} from '../common/types.ts'
import type {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
} from './stream.ts'

export type ProtocolRPCEncode = {
  buffer: ArrayBuffer
  streams: Record<number, ProtocolClientBlobStream>
}

export interface BaseClientDecoder {
  decode(buffer: ArrayBuffer): any
  decodeRPC(
    buffer: ArrayBuffer,
    context: DecodeRPCContext<ProtocolServerBlobStream>,
  ): ProtocolRPCResponse<ProtocolServerBlobStream>
}

export interface BaseClientEncoder {
  encode(data: any): ArrayBuffer
  encodeRPC(
    rpc: ProtocolRPC,
    context: EncodeRPCContext<ProtocolClientBlobStream>,
  ): ProtocolRPCEncode
}

export abstract class BaseClientFormat
  implements BaseClientDecoder, BaseClientEncoder
{
  abstract contentType: string

  abstract encode(data: any): ArrayBuffer
  abstract encodeRPC(
    rpc: ProtocolRPC,
    context: EncodeRPCContext<ProtocolClientBlobStream>,
  ): ProtocolRPCEncode
  abstract decode(buffer: ArrayBuffer): any
  abstract decodeRPC(
    buffer: ArrayBuffer,
    context: DecodeRPCContext<ProtocolServerBlobStream>,
  ): ProtocolRPCResponse<ProtocolServerBlobStream>
}
