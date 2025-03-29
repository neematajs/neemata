import type {
  BaseClientDecoder,
  BaseClientEncoder,
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPC,
  ProtocolRPCResponse,
} from '../common/types.ts'

export abstract class BaseClientFormat
  implements BaseClientDecoder, BaseClientEncoder
{
  abstract contentType: string

  abstract encode(data: any): ArrayBuffer
  abstract encodeRPC(rpc: ProtocolRPC, context: EncodeRPCContext): ArrayBuffer
  abstract decode(buffer: ArrayBuffer): any
  abstract decodeRPC(
    buffer: ArrayBuffer,
    context: DecodeRPCContext,
  ): ProtocolRPCResponse
}
