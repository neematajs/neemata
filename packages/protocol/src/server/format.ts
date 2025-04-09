import { match, type Pattern } from '@nmtjs/core'
import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolRPC,
  ProtocolRPCResponse,
} from '../common/types.ts'

export interface BaseServerDecoder {
  accept: Pattern[]
  decode(buffer: ArrayBuffer): any
  decodeRPC(buffer: ArrayBuffer, context: DecodeRPCContext): ProtocolRPC
}

export interface BaseServerEncoder {
  contentType: string
  encode(data: any): ArrayBuffer
  encodeRPC(rpc: ProtocolRPCResponse, context: EncodeRPCContext): ArrayBuffer
}

export abstract class BaseServerFormat
  implements BaseServerDecoder, BaseServerEncoder
{
  abstract accept: Pattern[]
  abstract contentType: string

  abstract encode(data: any): ArrayBuffer
  abstract encodeRPC(
    rpc: ProtocolRPCResponse,
    context: EncodeRPCContext,
  ): ArrayBuffer
  abstract decode(buffer: ArrayBuffer): any
  abstract decodeRPC(
    buffer: ArrayBuffer,
    context: DecodeRPCContext,
  ): ProtocolRPC
}

export const parseContentTypes = (types: string) => {
  if (types === '*/*') return ['*/*']
  return types
    .split(',')
    .map((t) => {
      const [type, ...rest] = t.split(';')
      const params = new Map(
        rest.map((p) =>
          p
            .trim()
            .split('=')
            .slice(0, 2)
            .map((p) => p.trim()),
        ) as [string, string][],
      )
      return {
        type,
        q: params.has('q') ? Number.parseFloat(params.get('q')!) : 1,
      }
    })
    .sort((a, b) => {
      if (a.type === '*/*') return 1
      if (b.type === '*/*') return -1
      return b.q - a.q ? -1 : 1
    })
    .map((t) => t.type)
}

export class Format {
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
