import { decode, ExtensionCodec, encode } from '@msgpack/msgpack'
import { isError } from '@nmtjs/common'

import type { ProtocolBlobMetadata } from '../common/blob.ts'
import type {
  DecodeRPCContext,
  ProtocolBlobInterface,
} from '../common/index.ts'
import { ProtocolBlob } from '../common/blob.ts'

export const STREAM_EXT_TYPE = 100
export const ERROR_EXT_TYPE = 101
export const JSON_EXT_TYPE = 102

// big-endian, unlike every other integer on the wire: changing it would
// change the frames, so it stays until the protocol version is bumped
const STREAM_ID_BYTES = 4

const hasToJSON = (value: any): value is { toJSON: () => any } => {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.toJSON === 'function'
  )
}

export const encodeStreamExt = (
  id: number,
  metadata: ProtocolBlobMetadata,
): Uint8Array => {
  const metadataBuffer = encode(metadata)
  const buffer = new Uint8Array(STREAM_ID_BYTES + metadataBuffer.byteLength)
  const view = new DataView(buffer.buffer)
  view.setUint32(0, id)
  buffer.set(metadataBuffer, STREAM_ID_BYTES)
  return buffer
}

export const decodeStreamExt = (
  data: Uint8Array,
): { id: number; metadata: ProtocolBlobMetadata } => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const id = view.getUint32(0)
  const metadata = decode(
    data.subarray(STREAM_ID_BYTES),
  ) as ProtocolBlobMetadata
  return { id, metadata }
}

export type MsgpackContext = {
  encodeStream?: (object: unknown) => Uint8Array | null
  decodeStream?: (data: Uint8Array) => unknown
}

// one codec for every operation: the dynamic encode/decode handlers travel
// in msgpack's per-call context instead
export const extensionCodec = new ExtensionCodec<MsgpackContext>()

extensionCodec.register({
  type: STREAM_EXT_TYPE,
  encode: (object: unknown, context: MsgpackContext): Uint8Array | null => {
    if (!(object instanceof ProtocolBlob)) return null
    return context.encodeStream?.(object) ?? null
  },
  // streams only ever appear in an RPC payload, which always supplies a
  // decoder for them
  decode: (data: Uint8Array, _extType: number, context: MsgpackContext) => {
    return context.decodeStream!(data)
  },
})

extensionCodec.register({
  type: ERROR_EXT_TYPE,
  encode: (object: unknown): Uint8Array | null => {
    if (isError(object)) {
      let error = { name: object.name, message: object.message }
      if (hasToJSON(object)) error = object.toJSON()
      return encode(error)
    }
    return null
  },
  decode: (data: Uint8Array) => {
    return decode(data)
  },
})

extensionCodec.register({
  type: JSON_EXT_TYPE,
  encode: (object: unknown): Uint8Array | null => {
    if (hasToJSON(object)) return encode(object.toJSON())
    return null
  },
  decode: (data: Uint8Array) => {
    return decode(data)
  },
})

export const decodeRPCFrame = (
  buffer: ArrayBufferView,
  context: DecodeRPCContext<ProtocolBlobInterface>,
) => {
  if (buffer.byteLength === 0) return undefined

  return decode(buffer, {
    extensionCodec,
    context: {
      decodeStream: (data: Uint8Array) => {
        const { id, metadata } = decodeStreamExt(data)
        return context.addStream(id, metadata)
      },
    },
  })
}
