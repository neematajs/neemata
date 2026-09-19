import type {
  DecodeRPCContext,
  EncodeRPCStreams,
  ProtocolBlobInterface,
} from '../common/index.ts'
import { concat, decodeNumber, encodeNumber } from '../common/index.ts'

const STREAM_SERIALIZE_KEY = '%neemata:stream:%\f'

const STREAMS_LENGTH_BYTES = Uint32Array.BYTES_PER_ELEMENT

export const serializeStreamId = (id: number) => {
  return `${STREAM_SERIALIZE_KEY}${id}`
}

export const deserializeStreamId = (value: string) => {
  return Number.parseInt(value.slice(STREAM_SERIALIZE_KEY.length), 10)
}

export const isStreamId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(STREAM_SERIALIZE_KEY)

/** `[streams length][streams?][payload?]`, the RPC frame both halves write. */
export const frameRPC = (
  streams: ArrayBufferView | undefined,
  payload: ArrayBufferView | undefined,
) => {
  const buffers: (ArrayBufferView | ArrayBuffer)[] = [
    encodeNumber(streams?.byteLength ?? 0, 'Uint32'),
  ]
  if (streams) buffers.push(streams)
  if (payload) buffers.push(payload)
  return concat(...buffers)
}

export const decodeRPCFrame = <T extends Uint8Array>(
  buffer: T,
  decode: (data: T, reviver?: (key: string, value: any) => any) => any,
  context: DecodeRPCContext<ProtocolBlobInterface>,
) => {
  const streamsLength = decodeNumber(buffer, 'Uint32')
  const payloadOffset = STREAMS_LENGTH_BYTES + streamsLength
  // a subarray keeps the caller's view type (a Buffer stays a Buffer), which
  // the declared signature of `subarray` cannot express
  const payload = buffer.subarray(payloadOffset) as T

  let streams: EncodeRPCStreams = {}
  if (streamsLength > 0) {
    streams = decode(buffer.subarray(STREAMS_LENGTH_BYTES, payloadOffset) as T)
  }

  if (payload.byteLength === 0) return undefined
  if (streamsLength === 0) return decode(payload)

  const reviver = (_key: string, value: unknown) => {
    if (isStreamId(value)) {
      const id = deserializeStreamId(value)
      return context.addStream(id, streams[id])
    }
    return value
  }

  return decode(payload, reviver)
}
