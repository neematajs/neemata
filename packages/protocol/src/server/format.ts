import type { Pattern } from '@nmtjs/common'
import { match } from '@nmtjs/common'

import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolRPCPayload,
} from '../common/types.ts'
import type { ProtocolClientStream } from './stream.ts'

export interface BaseServerDecoder {
  accept: Pattern[]
  decode(buffer: ArrayBufferView): unknown
  decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<() => ProtocolClientStream>,
  ): ProtocolRPCPayload
}

export interface BaseServerEncoder {
  contentType: string
  encode(data: unknown): ArrayBufferView
  encodeRPC(data: unknown, streams: EncodeRPCStreams): ArrayBufferView
  encodeBlob(streamId: number): unknown
}

export abstract class BaseServerFormat
  implements BaseServerDecoder, BaseServerEncoder
{
  abstract accept: Pattern[]
  abstract contentType: string

  abstract encode(data: unknown): ArrayBufferView
  abstract encodeRPC(data: unknown, streams: EncodeRPCStreams): ArrayBufferView
  abstract encodeBlob(streamId: number): unknown
  abstract decode(buffer: ArrayBufferView): any
  abstract decodeRPC(
    buffer: ArrayBufferView,
    context: DecodeRPCContext<() => ProtocolClientStream>,
  ): ProtocolRPCPayload
}

export const parseContentTypes = (types: string) => {
  const normalized = types.trim()
  if (normalized === '*/*') return ['*/*']
  return normalized
    .split(',')
    .map((t) => t.trim())
    .map((t) => {
      const [rawType, ...rest] = t.split(';')
      const params = new Map(
        rest.map((p) =>
          p
            .trim()
            .split('=')
            .slice(0, 2)
            .map((part) => part.trim()),
        ) as [string, string][],
      )
      return {
        type: rawType.trim(),
        q: params.has('q') ? Number.parseFloat(params.get('q')!) : 1,
      }
    })
    .sort((a, b) => {
      if (a.type === '*/*') return 1
      if (b.type === '*/*') return -1
      return b.q - a.q
    })
    .map((t) => t.type)
}

export class ProtocolFormats {
  decoders = new Map<Pattern, BaseServerDecoder>()
  encoders = new Map<Pattern, BaseServerEncoder>()

  constructor(formats: BaseServerFormat[]) {
    for (const format of formats) {
      this.encoders.set(format.contentType, format)
      for (const acceptType of format.accept) {
        this.decoders.set(acceptType, format)
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
    formats: Map<Pattern, T>,
    contentType: string,
    throwIfUnsupported = false,
  ): T | null {
    // TODO: Use node:utils.MIMEType (not implemented yet in Deno and Bun yet)
    const types = parseContentTypes(contentType)

    for (const type of types) {
      for (const [pattern, format] of formats) {
        if (type === '*/*' || match(type, pattern)) return format
      }
    }

    if (throwIfUnsupported)
      throw new Error(`No supported format found: ${contentType}`)

    return null
  }
}
