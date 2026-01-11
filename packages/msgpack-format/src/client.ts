import type { DecodeRPCContext } from '@nmtjs/protocol'
import type {
  EncodeRPCContext,
  ProtocolClientBlobStream,
  ProtocolServerBlobStream,
} from '@nmtjs/protocol/client'
import { decode, encode } from '@msgpack/msgpack'
import { ProtocolBlob } from '@nmtjs/protocol'
import { BaseClientFormat } from '@nmtjs/protocol/client'

import { decodeStreamExt, encodeStreamExt, extensionCodec } from './common.ts'

/**
 * MessagePack encoding format with support for Neemata streams.
 * Uses extension types to embed stream ID + metadata directly,
 * eliminating the need for separate stream metadata chunks.
 */
export class MsgpackFormat extends BaseClientFormat {
  contentType = 'application/msgpack'

  encode(data: any): Uint8Array {
    return encode(data, { ignoreUndefined: true })
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
    return decode(data)
  }

  decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<
      (options?: { signal?: AbortSignal }) => ProtocolServerBlobStream
    >,
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
