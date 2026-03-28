import type { ProtocolBlob, ProtocolBlobInterface } from '../common/blob.ts'
import type { DecodeRPCContext } from '../common/types.ts'
import type { ProtocolClientBlobStream } from './stream.ts'

export interface EncodeRPCContext<T = any> {
  addStream: (blob: ProtocolBlob) => T
}

export type ProtocolRPCEncode = ArrayBufferView

export interface BaseClientDecoder {
  decode(buffer: ArrayBufferView): unknown
  decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<ProtocolBlobInterface>,
  ): unknown
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
    context: EncodeRPCContext,
  ): ProtocolRPCEncode
  abstract decode(buffer: ArrayBufferView): unknown
  abstract decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<ProtocolBlobInterface>,
  ): unknown
}
