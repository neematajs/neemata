import type { ProtocolBlobMetadata } from '@nmtjs/protocol'

// TODO: is this a good way to serialize streams within json?
const STREAM_SERIALIZE_KEY = '%neemata:stream:%\f'
// prepended on encode to user strings that could be mistaken for a stream ref
// (or for an already-escaped string), stripped back off on decode — so user
// data can never mint stream state and still survives the round trip intact
const STREAM_ESCAPE_KEY = '%neemata:escape:%\f'

export const serializeStreamId = (id: number) => {
  return `${STREAM_SERIALIZE_KEY}${id}`
}

export const deserializeStreamId = (value: string) => {
  const streamId = value.slice(STREAM_SERIALIZE_KEY.length)
  // parseInt would accept trailing garbage like "1abc"
  return /^\d+$/.test(streamId) ? Number.parseInt(streamId) : null
}

export const isStreamId = (value: any): value is string => {
  return typeof value === 'string' && value.startsWith(STREAM_SERIALIZE_KEY)
}

export const needsEscaping = (value: string) => {
  return (
    value.startsWith(STREAM_SERIALIZE_KEY) ||
    value.startsWith(STREAM_ESCAPE_KEY)
  )
}

export const escapeStreamLikeString = (value: string) => {
  return `${STREAM_ESCAPE_KEY}${value}`
}

export const unescapeStreamLikeString = (value: string) => {
  return value.startsWith(STREAM_ESCAPE_KEY)
    ? value.slice(STREAM_ESCAPE_KEY.length)
    : value
}

export type StreamsMetadata = Record<number, ProtocolBlobMetadata>

// Stream ids are declared out of band in the message's streams map; the
// in-band ref only marks a position. Only declared ids may mint stream state,
// and each at most once — duplicates resolve to the already-created stream,
// while undeclared or malformed refs stay plain user data instead of becoming
// phantom timer-backed streams or colliding with a legit one.
export const createStreamReviver = (
  streams: StreamsMetadata,
  addStream: (id: number, metadata: ProtocolBlobMetadata) => unknown,
) => {
  const created = new Map<number, unknown>()
  return (_key: string, value: any) => {
    if (typeof value !== 'string') return value
    if (isStreamId(value)) {
      const id = deserializeStreamId(value)
      if (id !== null && Object.hasOwn(streams, id)) {
        if (!created.has(id)) created.set(id, addStream(id, streams[id]))
        return created.get(id)
      }
      return value
    }
    return unescapeStreamLikeString(value)
  }
}

export type ClientEncodedRPC = [streams: StreamsMetadata, payload?: any]
export type ServerEncodedRPC = [streams: StreamsMetadata, payload?: any]
