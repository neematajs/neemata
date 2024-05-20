import { Encoder, ExtensionCodec, decode } from '@msgpack/msgpack'
import type { DecodeRpcContext, StreamMetadata } from '@neematajs/common'
import { BaseServerFormat } from '@neematajs/common'
import { STREAM_EXT_TYPE, registerJsonLikeExtension } from './common'

const extensionCodec = new ExtensionCodec<DecodeRpcContext>()
const encoder = new Encoder({ useBigInt64: true })
extensionCodec.register({
  type: STREAM_EXT_TYPE,
  encode: () => null,
  decode: (value, type, ctx) => {
    const [id, metadata] = decode(value) as [number, StreamMetadata]
    ctx.addStream(id, metadata)
    return ctx.getStream(id)
  },
})
registerJsonLikeExtension(extensionCodec)

export class MessagepackFormat extends BaseServerFormat {
  accepts = ['application/x-msgpack']
  mime = 'application/x-msgpack'

  encode(data: any): ArrayBuffer {
    return encoder.encode(data).buffer
  }

  decode(data: ArrayBuffer): any {
    return decode(new Uint8Array(data), { useBigInt64: true })
  }

  decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext): any {
    return decode(new Uint8Array(buffer), {
      useBigInt64: true,
      extensionCodec,
      context,
    })
  }
}
