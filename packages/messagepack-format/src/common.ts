import { type ExtensionCodec, decode, encode } from '@msgpack/msgpack'

export const STREAM_EXT_TYPE = 0
export const JSON_EXT_TYPE = 1

export const registerJsonLikeExtension = (
  extensionCodec: ExtensionCodec<any>,
) => {
  extensionCodec.register({
    type: JSON_EXT_TYPE,
    encode: (value: any, context) => {
      if ('toJSON' in value && typeof value.toJSON === 'function') {
        return encode(value.toJSON(), {
          extensionCodec,
          context,
          useBigInt64: true,
        })
      }
      return null
    },
    decode: (value, type, context) => {
      return decode(value, { extensionCodec, useBigInt64: true, context })
    },
  })
}
