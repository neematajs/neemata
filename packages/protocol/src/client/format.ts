import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPCResponse,
} from '../common/types.ts'
import type {
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
} from './stream.ts'

export type ProtocolRPCEncode = ArrayBufferView

export interface BaseClientDecoder {
  decode(buffer: ArrayBufferView): unknown
  decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<ProtocolServerBlobStream>,
  ): ProtocolRPCResponse<ProtocolServerBlobStream>
}

export interface BaseClientEncoder {
  encode(data: unknown): ArrayBufferView
  encodeRPC(
    data: unknown,
    context: EncodeRPCContext<ProtocolClientBlobStream>,
  ): ProtocolRPCEncode
}

export abstract class BaseClientFormat
  implements BaseClientDecoder, BaseClientEncoder
{
  abstract contentType: string

  abstract encode(data: unknown): ArrayBufferView
  abstract encodeRPC(
    data: unknown,
    context: EncodeRPCContext<ProtocolClientBlobStream>,
  ): ProtocolRPCEncode
  abstract decode(buffer: ArrayBufferView): unknown
  abstract decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<ProtocolServerBlobStream>,
  ): ProtocolRPCResponse<ProtocolServerBlobStream>
}
