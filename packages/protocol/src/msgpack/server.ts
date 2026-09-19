/// <reference types="node" />

import { decode, encode } from '@msgpack/msgpack'

import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/index.ts'
import { ProtocolBlob } from '../common/blob.ts'
import { BaseServerCodec } from '../server/codec.ts'
import { decodeRPCFrame, encodeStreamExt, extensionCodec } from './common.ts'

// stands in for a blob until the payload is encoded, so the api layer can
// hand back a value the codec recognises as a stream reference
class StreamIdMarker {
  constructor(
    public readonly streamId: number,
    public readonly metadata: ProtocolBlobMetadata,
  ) {}
}

export class MsgpackCodec extends BaseServerCodec {
  contentType = 'application/msgpack'
  accept = ['application/msgpack']

  encode(data: any) {
    // Encoding undefined would produce a zero-byte frame that gets silently
    // dropped over SSE and breaks decoding over WS — reject it early instead
    if (data === undefined) {
      throw new TypeError('Cannot encode undefined')
    }
    return Buffer.from(
      encode(data, { extensionCodec, context: {}, ignoreUndefined: true }),
    )
  }

  encodeBlob(streamId: number, metadata: EncodeRPCStreams[number]) {
    return new StreamIdMarker(streamId, metadata)
  }

  encodeRPC(data: unknown, _streams: EncodeRPCStreams) {
    if (data === undefined) {
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
              const marker = object.encode(object.metadata)
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
    if (data.byteLength === 0) {
      return undefined
    }

    return decode(data, { extensionCodec, context: {} })
  }

  decodeRPC(buffer: Buffer, context: DecodeRPCContext<ProtocolBlobInterface>) {
    return decodeRPCFrame(buffer, context)
  }
}
