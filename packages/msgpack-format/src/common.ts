import type { ProtocolBlobMetadata } from '@nmtjs/protocol'
import { decode, ExtensionCodec, encode } from '@msgpack/msgpack'

// Extension type code for blob streams
export const STREAM_EXT_TYPE = 0x01

// Encodes stream ID + metadata into extension type payload
export const encodeStreamExt = (
  id: number,
  metadata: ProtocolBlobMetadata,
): Uint8Array => {
  // Format: [id: u32 BE][metadata: msgpack]
  const metadataBuffer = encode(metadata)
  const buffer = new Uint8Array(4 + metadataBuffer.byteLength)
  const view = new DataView(buffer.buffer)
  view.setUint32(0, id, false) // big-endian
  buffer.set(metadataBuffer, 4)
  return buffer
}

// Decodes stream ID + metadata from extension type payload
export const decodeStreamExt = (
  data: Uint8Array,
): { id: number; metadata: ProtocolBlobMetadata } => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const id = view.getUint32(0, false)
  const metadata = decode(data.subarray(4)) as ProtocolBlobMetadata
  return { id, metadata }
}

// Context type for encode/decode operations
export type MsgpackContext = {
  encodeStream?: (object: unknown) => Uint8Array | null
  decodeStream?: (data: Uint8Array) => unknown
}

// Shared extension codec - reused across all encode/decode operations
// Uses msgpack's context feature to pass dynamic encode/decode handlers
export const extensionCodec = new ExtensionCodec<MsgpackContext>()

extensionCodec.register({
  type: STREAM_EXT_TYPE,
  encode: (object: unknown, context: MsgpackContext): Uint8Array | null => {
    return context.encodeStream!(object) ?? null
  },
  decode: (data: Uint8Array, _extType: number, context: MsgpackContext) => {
    return context.decodeStream!(data)
  },
})
