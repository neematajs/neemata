import { type ExtensionCodec, decode, encode } from '@msgpack/msgpack'

export const STREAM_EXT_TYPE = 0
export const JSON_EXT_TYPE = 1

export const registerJsonLikeExtension = (extension: ExtensionCodec<any>) => {
  extension.register({
    type: JSON_EXT_TYPE,
    encode: (value: any) => {
      if ('toJSON' in value && typeof value.toJSON === 'function') {
        return encode(value.toJSON())
      }
      return null
    },
    decode: (value, type, ctx) => {
      return decode(value)
    },
  })
}
