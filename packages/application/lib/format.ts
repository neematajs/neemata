import type { BaseServerFormat, DecodeRpcContext } from '@neematajs/common'
import { match, parseContentTypes } from './utils/functions.ts'

export class Format {
  supported = new Map<string, BaseServerFormat>()

  constructor(formats: BaseServerFormat[]) {
    for (const format of formats) {
      for (const accept of format.accepts) {
        this.supported.set(accept, format)
      }
    }
  }

  supports(contentType: string, throwIfUnsupported = false) {
    const types = parseContentTypes(contentType)

    for (const type of types) {
      for (const [pattern, format] of this.supported) {
        if (type === '*/*' || match(type, pattern)) return format
      }
    }

    if (throwIfUnsupported)
      throw new Error(`No supported format found: ${contentType}`)

    return null
  }

  decode(type: string, data: ArrayBuffer) {
    const format = this.supports(type, true)!
    return format.decode(data)
  }

  decodeRpc(type: string, data: ArrayBuffer, context: DecodeRpcContext) {
    const format = this.supports(type, true)!
    return format.decodeRpc(data, context)
  }

  encode(type: string, data: any) {
    const format = this.supports(type, true)!
    return format.encode(data)
  }
}
