import type { DecodeRPCContext, EncodeRPCStreams } from '@nmtjs/protocol'
import type { ProtocolClientStream } from '@nmtjs/protocol/server'
import { decode, encode } from '@msgpack/msgpack'
import { ProtocolBlob } from '@nmtjs/protocol'
import { BaseServerFormat } from '@nmtjs/protocol/server'

import { decodeStreamExt, encodeStreamExt, extensionCodec } from './common.ts'

// Marker class for stream IDs (used internally for msgpack extension encoding)
class StreamIdMarker {
  constructor(
    public readonly streamId: number,
    public readonly metadata: {
      type: string
      size?: number
      filename?: string
    },
  ) {}
}

export class MsgpackFormat extends BaseServerFormat {
  contentType = 'application/msgpack'
  accept = ['application/msgpack']

  encode(data: any) {
    return typeof data !== 'undefined'
      ? Buffer.from(encode(data, { ignoreUndefined: true }))
      : Buffer.alloc(0)
  }

  encodeBlob(streamId: number, metadata: EncodeRPCStreams[number]) {
    return new StreamIdMarker(streamId, metadata)
  }

  encodeRPC(data: unknown, _streams: EncodeRPCStreams) {
    if (typeof data === 'undefined') {
      return Buffer.alloc(0)
    }

    return Buffer.from(
      encode(data, {
        extensionCodec,
        ignoreUndefined: true,
        context: {
          encodeStream: (object: unknown): Uint8Array | null => {
            if (object instanceof StreamIdMarker) {
              return encodeStreamExt(object.streamId, object.metadata)
            }
            if (object instanceof ProtocolBlob && object.encode) {
              const marker = object.encode(object.metadata) as StreamIdMarker
              if (marker instanceof StreamIdMarker) {
                return encodeStreamExt(marker.streamId, marker.metadata)
              }
            }
            return null
          },
        },
      }),
    )
  }

  decode(data: Buffer) {
    return decode(data)
  }

  decodeRPC(
    buffer: Buffer,
    context: DecodeRPCContext<() => ProtocolClientStream>,
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
