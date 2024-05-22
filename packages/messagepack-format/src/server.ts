import { ExtensionCodec, decode, encode } from '@msgpack/msgpack'
import type { DecodeRpcContext, StreamMetadata } from '@neematajs/common'
import { BaseServerFormat } from '@neematajs/common'
import { STREAM_EXT_TYPE, registerJsonLikeExtension } from './common'

const extensionCodec = new ExtensionCodec<any>()

extensionCodec.register({
  type: STREAM_EXT_TYPE,
  encode: () => null,
  decode: (value, type, ctx: DecodeRpcContext) => {
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
    const encoded = encode(data, { extensionCodec })
    return encoded.buffer.slice(0, encoded.byteLength)
  }

  decode(data: ArrayBuffer): any {
    return decode(new Uint8Array(data), { extensionCodec })
  }

  decodeRpc(buffer: ArrayBuffer, context: DecodeRpcContext) {
    const [callId, name, payload] = decode(new Uint8Array(buffer), {
      useBigInt64: true,
      extensionCodec,
      context,
    }) as any
    return { callId, name, payload }
  }
}
