import { MIMEType } from 'node:util'

import type { Pattern } from '@nmtjs/common'
import { match } from '@nmtjs/common'

import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '../common/blob.ts'
import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolRPCPayload,
} from '../common/types.ts'

export interface BaseServerDecoder {
  accept: Pattern[]
  decode(buffer: ArrayBufferView): unknown
  decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<ProtocolBlobInterface>,
  ): ProtocolRPCPayload
}

export interface BaseServerEncoder {
  contentType: string
  encode(data: unknown): ArrayBufferView
  encodeRPC(data: unknown, streams: EncodeRPCStreams): ArrayBufferView
  encodeBlob(streamId: number, metadata: ProtocolBlobMetadata): unknown
}

export abstract class BaseServerCodec
  implements BaseServerDecoder, BaseServerEncoder
{
  abstract accept: Pattern[]
  abstract contentType: string

  abstract encode(data: unknown): ArrayBufferView
  abstract encodeRPC(data: unknown, streams: EncodeRPCStreams): ArrayBufferView
  abstract encodeBlob(streamId: number, metadata: ProtocolBlobMetadata): unknown
  abstract decode(buffer: ArrayBufferView): any
  abstract decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<ProtocolBlobInterface>,
  ): ProtocolRPCPayload
}

export const parseContentTypes = (types: string) => {
  const normalized = types.trim()
  if (normalized === '*/*') return ['*/*']
  return normalized
    .split(',')
    .map((t) => t.trim())
    .map((t) => {
      const mime = new MIMEType(t)
      return {
        type: mime.essence,
        q: Number.parseFloat(mime.params.get('q') ?? '1'),
      }
    })
    .sort((a, b) => {
      if (a.type === '*/*') return 1
      if (b.type === '*/*') return -1
      return b.q - a.q
    })
    .map((t) => t.type)
}

export class ProtocolCodecRegistry {
  decoders = new Map<Pattern, BaseServerDecoder>()
  encoders = new Map<Pattern, BaseServerEncoder>()

  default: BaseServerCodec

  constructor(codecs: [BaseServerCodec, ...BaseServerCodec[]]) {
    this.default = codecs[0]
    for (const codec of codecs) {
      this.encoders.set(codec.contentType, codec)
      for (const acceptType of codec.accept) {
        this.decoders.set(acceptType, codec)
      }
    }
  }

  supportsDecoder(contentType: string, throwIfUnsupported = false) {
    return this.supports(this.decoders, contentType, throwIfUnsupported)
  }

  supportsEncoder(contentType: string, throwIfUnsupported = false) {
    return this.supports(this.encoders, contentType, throwIfUnsupported)
  }

  private supports<T extends BaseServerEncoder | BaseServerDecoder>(
    codecs: Map<Pattern, T>,
    contentType: string,
    throwIfUnsupported = false,
  ): T | null {
    const types = parseContentTypes(contentType)

    for (const type of types) {
      for (const [pattern, codec] of codecs) {
        if (type === '*/*' || match(type, pattern)) return codec
      }
    }

    if (throwIfUnsupported)
      throw new Error(`No supported codec found: ${contentType}`)

    return null
  }
}
