import type { ProtocolBlobMetadata } from '@nmtjs/protocol'
import { decode, ExtensionCodec, encode } from '@msgpack/msgpack'
import { decodeText, encodeText } from '@nmtjs/protocol'

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

export const registerTemporalTypes = (Temporal: typeof globalThis.Temporal) => {
  const TEMPORAL_PLAIN_DATE_EXT_TYPE = 0x02
  const TEMPORAL_PLAIN_DATETIME_EXT_TYPE = 0x03
  const TEMPORAL_PLAIN_TIME_EXT_TYPE = 0x04
  const TEMPORAL_PLAIN_YEAR_MONTH_EXT_TYPE = 0x05
  const TEMPORAL_PLAIN_MONTH_DAY_EXT_TYPE = 0x06
  const TEMPORAL_DURATION_EXT_TYPE = 0x07
  const TEMPORAL_ZONED_DATETIME_EXT_TYPE = 0x08
  const TEMPORAL_INSTANT_EXT_TYPE = 0x09

  const temporalTypes = new Map<
    number,
    | typeof Temporal.Duration
    | typeof Temporal.PlainDate
    | typeof Temporal.PlainDateTime
    | typeof Temporal.PlainTime
    | typeof Temporal.PlainYearMonth
    | typeof Temporal.PlainMonthDay
    | typeof Temporal.ZonedDateTime
    | typeof Temporal.Instant
  >()

  temporalTypes.set(TEMPORAL_PLAIN_DATE_EXT_TYPE, Temporal.PlainDate)
  temporalTypes.set(TEMPORAL_PLAIN_DATETIME_EXT_TYPE, Temporal.PlainDateTime)
  temporalTypes.set(TEMPORAL_PLAIN_TIME_EXT_TYPE, Temporal.PlainTime)
  temporalTypes.set(TEMPORAL_PLAIN_YEAR_MONTH_EXT_TYPE, Temporal.PlainYearMonth)
  temporalTypes.set(TEMPORAL_PLAIN_MONTH_DAY_EXT_TYPE, Temporal.PlainMonthDay)
  temporalTypes.set(TEMPORAL_DURATION_EXT_TYPE, Temporal.Duration)
  temporalTypes.set(TEMPORAL_ZONED_DATETIME_EXT_TYPE, Temporal.ZonedDateTime)
  temporalTypes.set(TEMPORAL_INSTANT_EXT_TYPE, Temporal.Instant)

  for (const [type, TemporalClass] of temporalTypes) {
    extensionCodec.register({
      type,
      encode: (object) => {
        if (object instanceof TemporalClass) {
          return encodeText(
            (object as InstanceType<typeof TemporalClass>).toJSON(),
          )
        }
        return null
      },
      decode: (data) => {
        return decodeText(data)
      },
    })
  }
}

extensionCodec.register({
  type: STREAM_EXT_TYPE,
  encode: (object: unknown, context: MsgpackContext): Uint8Array | null => {
    return context.encodeStream?.(object) ?? null
  },
  decode: (data: Uint8Array, _extType: number, context: MsgpackContext) => {
    return context.decodeStream!(data)
  },
})
