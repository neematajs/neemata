import { MAX_UINT32 } from '@nmtjs/common'

import type { ProtocolBlobMetadata } from '../common/blob.ts'

// TODO: is this a good way to serialize streams within json?
const STREAM_SERIALIZE_KEY = '%neemata:stream:%\f'
const STREAM_ESCAPE_KEY = '%neemata:escape:%\f'

export const serializeStreamId = (id: number) => {
  return `${STREAM_SERIALIZE_KEY}${id}`
}

export const deserializeStreamId = (value: string) => {
  const streamId = value.slice(STREAM_SERIALIZE_KEY.length)
  // Only the canonical decimal form can name a wire-level Uint32 stream.
  if (!/^(?:0|[1-9]\d{0,9})$/.test(streamId)) return null
  const id = Number.parseInt(streamId)
  return id <= MAX_UINT32 ? id : null
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
  if (!value.startsWith(STREAM_ESCAPE_KEY)) return value
  const suffix = value.slice(STREAM_ESCAPE_KEY.length)
  // The encoder only adds this prefix to stream-like or already-escaped
  // values, so a raw prefix followed by ordinary data must stay untouched.
  return needsEscaping(suffix) ? suffix : value
}

export type StreamsMetadata = Record<number, ProtocolBlobMetadata>

export const assertStreamsMetadata = (value: unknown): StreamsMetadata => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Malformed streams metadata section')
  }
  return value as StreamsMetadata
}

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
