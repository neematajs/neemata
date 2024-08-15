import type {
  BaseServerDecoder,
  BaseServerEncoder,
  BaseServerFormat,
  Pattern,
} from '@nmtjs/common'
import { match, parseContentTypes } from './utils/functions.ts'

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
    throwIfUnsupported,
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
