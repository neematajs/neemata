import { decode, encode } from '@msgpack/msgpack'

import type {
  EncodeRPCContext,
  ProtocolClientBlobStream,
} from '../client/index.ts'
import type {
  DecodeRPCContext,
  ProtocolBlobInterface,
} from '../common/index.ts'
import { BaseClientCodec } from '../client/codec.ts'
import { ProtocolBlob } from '../common/blob.ts'
import { decodeStreamExt, encodeStreamExt, extensionCodec } from './common.ts'

/**
 * MessagePack codec with support for Neemata streams.
 * Uses extension types to embed stream ID + metadata directly,
 * eliminating the need for separate stream metadata chunks.
 */
export class MsgpackCodec extends BaseClientCodec {
  contentType = 'application/msgpack'

  encode(data: any): Uint8Array {
    if (typeof data === 'undefined') {
      return new Uint8Array(0)
    }

    return encode(data, { extensionCodec, ignoreUndefined: true, context: {} })
  }

  encodeRPC(
    data: unknown,
    context: EncodeRPCContext<ProtocolClientBlobStream>,
  ) {
    if (typeof data === 'undefined') {
      return new Uint8Array(0)
    }

    return encode(data, {
      extensionCodec,
      ignoreUndefined: true,
      context: {
        encodeStream: (object: unknown): Uint8Array | null => {
          if (object instanceof ProtocolBlob) {
            const stream = context.addStream(object)
            return encodeStreamExt(stream.id, stream.metadata)
          }
          return null
        },
      },
    })
  }

  decode(data: ArrayBufferView): any {
    if (data.byteLength === 0) {
      return undefined
    }

    return decode(data, { extensionCodec, context: {} })
  }

  decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<ProtocolBlobInterface>,
  ) {
    if (buffer.byteLength === 0) {
      return undefined
    }

    return decode(buffer, {
      extensionCodec,
      context: {
        decodeStream: (data: Uint8Array) => {
          const { id, metadata } = decodeStreamExt(data)
          return context.addStream(id, metadata)
        },
      },
    })
  }
}
